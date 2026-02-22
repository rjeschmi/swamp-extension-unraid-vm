import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe("Unraid SSH hostname or IP"),
  sshUser: z.string().describe("SSH username (root on Unraid)"),
  sshPrivateKey: z.string().describe("SSH private key for Unraid"),
  vmSshUser: z.string().describe("Username on the VM (created by cloud-init)"),
  vmSshPrivateKey: z.string().describe("SSH private key for the VM user"),
});

const ClusterSchema = z.object({
  vmName: z.string(),
  vmIp: z.string(),
  k3sVersion: z.string(),
  rancherVersion: z.string(),
  rancherUrl: z.string(),
  bootstrapPassword: z.string(),
});

const dec = new TextDecoder();

async function runSsh(keyFile, user, host, command, { allowFailure = false } = {}) {
  const proc = new Deno.Command("ssh", {
    args: [
      "-i", keyFile,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=40",
      `${user}@${host.replace(/\.$/, "")}`,
      command,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const result = await proc.output();
  const stdout = dec.decode(result.stdout).trim();
  const stderr = dec.decode(result.stderr).trim();

  if (!allowFailure && result.code !== 0) {
    throw new Error(`SSH failed (exit ${result.code}):\n$ ${command}\nstderr: ${stderr}`);
  }
  return { stdout, stderr, code: result.code };
}

export const model = {
  type: "@rjeschmi/rancher",
  version: "2026.02.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    cluster: {
      description: "A provisioned Rancher cluster",
      schema: ClusterSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    install: {
      description: "Install k3s + Rancher on a provisioned VM via SSH",
      arguments: z.object({
        vmName: z.string().describe("VM name, used to discover IP via virsh"),
        rancherVersion: z.string().optional().describe("Rancher Helm chart version (default: latest)"),
        timeoutSeconds: z.number().int().optional().describe("Max seconds to wait (default: 600)"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, vmSshUser, vmSshPrivateKey } = context.globalArgs;
        const { vmName } = args;
        const rancherVersion = args.rancherVersion ?? "latest";
        const timeoutMs = (args.timeoutSeconds ?? 600) * 1000;
        const pollInterval = 10_000;

        const rootKeyFile = `/tmp/.swamp-rancher-root-${Date.now()}`;
        const vmKeyFile = `/tmp/.swamp-rancher-vm-${Date.now()}`;
        const rootKeyContent = sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n";
        const vmKeyContent = vmSshPrivateKey.endsWith("\n") ? vmSshPrivateKey : vmSshPrivateKey + "\n";
        await Deno.writeTextFile(rootKeyFile, rootKeyContent, { mode: 0o600 });
        await Deno.writeTextFile(vmKeyFile, vmKeyContent, { mode: 0o600 });

        const rootSsh = (cmd, opts) => runSsh(rootKeyFile, sshUser, sshHost, cmd, opts);

        let vmIp = null;

        try {
          context.logger.info(`Installing Rancher on VM '${vmName}'...`);
          const deadline = Date.now() + timeoutMs;

          // 1. Poll virsh for VM IP via guest agent
          context.logger.info("Waiting for VM IP via virsh domifaddr...");
          while (Date.now() < deadline) {
            const res = await rootSsh(
              `virsh domifaddr '${vmName}' --source agent 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | grep -v '^127\\.' | grep -v '^169\\.254\\.' | head -1`,
              { allowFailure: true },
            );
            if (res.stdout && res.stdout.trim() !== "") {
              vmIp = res.stdout.trim();
              context.logger.info(`VM IP: ${vmIp}`);
              break;
            }
            context.logger.info("No IP yet, retrying in 10s...");
            await new Promise((r) => setTimeout(r, pollInterval));
          }

          if (!vmIp) {
            throw new Error(`VM '${vmName}' did not get an IP within timeout`);
          }

          // 2. Poll until VM SSH is ready
          context.logger.info("Waiting for VM SSH to become ready...");
          let sshReady = false;
          while (Date.now() < deadline) {
            const res = await runSsh(vmKeyFile, vmSshUser, vmIp, "echo ready", { allowFailure: true });
            if (res.code === 0 && res.stdout.trim() === "ready") {
              sshReady = true;
              break;
            }
            context.logger.info("VM SSH not ready yet, retrying in 10s...");
            await new Promise((r) => setTimeout(r, pollInterval));
          }

          if (!sshReady) {
            throw new Error(`VM '${vmName}' SSH not available within timeout`);
          }

          const vmSsh = (cmd, opts) => runSsh(vmKeyFile, vmSshUser, vmIp, cmd, opts);

          // 3. Install k3s (Traefik ingress controller included by default)
          context.logger.info("Installing k3s...");
          await vmSsh(`curl -sfL https://get.k3s.io | sh -`);
          context.logger.info("k3s installed.");

          // 4. Wait for k3s node to register, then wait for ready
          context.logger.info("Waiting for k3s node to register...");
          {
            const nodeDeadline = Date.now() + 120_000;
            let nodeFound = false;
            while (Date.now() < nodeDeadline) {
              const res = await vmSsh(`sudo k3s kubectl get nodes --no-headers 2>/dev/null | wc -l`, { allowFailure: true });
              if (res.code === 0 && parseInt(res.stdout.trim(), 10) > 0) {
                nodeFound = true;
                break;
              }
              context.logger.info("No node registered yet, retrying in 5s...");
              await new Promise((r) => setTimeout(r, 5_000));
            }
            if (!nodeFound) throw new Error("k3s node did not register within 120s");
          }
          context.logger.info("Node registered. Waiting for ready condition...");
          await vmSsh(`sudo k3s kubectl wait --for=condition=ready node --all --timeout=120s`);
          context.logger.info("k3s node ready.");

          // 5. Install Helm
          context.logger.info("Installing Helm...");
          await vmSsh(`curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash`);
          context.logger.info("Helm installed.");

          // 6. Add Helm repos and update
          context.logger.info("Adding Helm repos...");
          await vmSsh(
            `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && ` +
            `sudo -E helm repo add jetstack https://charts.jetstack.io && ` +
            `sudo -E helm repo add rancher-latest https://releases.rancher.com/server-charts/latest && ` +
            `sudo -E helm repo update`,
          );

          // 7. Install cert-manager
          context.logger.info("Installing cert-manager via Helm...");
          await vmSsh(
            `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && ` +
            `sudo -E helm upgrade --install cert-manager jetstack/cert-manager ` +
            `--namespace cert-manager --create-namespace ` +
            `--set crds.enabled=true --wait --timeout 300s`,
          );
          context.logger.info("cert-manager installed.");

          // 8. Install Rancher
          const hostname = `${vmIp}.sslip.io`;
          const rancherVersionFlag = rancherVersion === "latest" ? "" : `--version ${rancherVersion}`;
          context.logger.info(`Installing Rancher at https://${hostname}...`);
          await vmSsh(
            `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && ` +
            `sudo -E helm upgrade --install rancher rancher-latest/rancher ` +
            `--namespace cattle-system --create-namespace ` +
            `--set hostname=${hostname} ` +
            `--set bootstrapPassword=admin ` +
            `--set ingress.tls.source=rancher ` +
            `--set ingress.ingressClassName=traefik ` +
            `${rancherVersionFlag} --wait --timeout 1200s`,
          );
          context.logger.info("Rancher Helm chart installed.");

          // 9. Wait for Rancher rollout
          context.logger.info("Waiting for Rancher deployment rollout...");
          await vmSsh(
            `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && ` +
            `sudo -E kubectl -n cattle-system rollout status deploy/rancher --timeout=600s`,
          );

          const rancherUrl = `https://${hostname}`;
          context.logger.info(`Rancher is ready at: ${rancherUrl}`);
          context.logger.info(`Bootstrap password: admin`);

          // Detect k3s version
          const k3sVersionRes = await vmSsh(`k3s --version | head -1`, { allowFailure: true });
          const k3sVersion = k3sVersionRes.stdout.replace(/^k3s version /, "").split(" ")[0] || "unknown";

          const handle = await context.writeResource("cluster", vmName, {
            vmName,
            vmIp,
            k3sVersion,
            rancherVersion,
            rancherUrl,
            bootstrapPassword: "admin",
          });

          return { dataHandles: [handle] };
        } finally {
          await Deno.remove(rootKeyFile).catch(() => {});
          await Deno.remove(vmKeyFile).catch(() => {});
        }
      },
    },

    uninstall: {
      description: "Uninstall k3s (and therefore Rancher) from the VM",
      arguments: z.object({
        vmName: z.string().describe("VM name, used to discover IP via virsh"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, vmSshUser, vmSshPrivateKey } = context.globalArgs;
        const { vmName } = args;

        const rootKeyFile = `/tmp/.swamp-rancher-root-${Date.now()}`;
        const vmKeyFile = `/tmp/.swamp-rancher-vm-${Date.now()}`;
        const rootKeyContent = sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n";
        const vmKeyContent = vmSshPrivateKey.endsWith("\n") ? vmSshPrivateKey : vmSshPrivateKey + "\n";
        await Deno.writeTextFile(rootKeyFile, rootKeyContent, { mode: 0o600 });
        await Deno.writeTextFile(vmKeyFile, vmKeyContent, { mode: 0o600 });

        try {
          context.logger.info(`Discovering IP for VM '${vmName}'...`);
          const ipRes = await runSsh(
            rootKeyFile, sshUser, sshHost,
            `virsh domifaddr '${vmName}' --source agent 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | grep -v '^127\\.' | grep -v '^169\\.254\\.' | head -1`,
            { allowFailure: true },
          );
          const vmIp = ipRes.stdout.trim();
          if (!vmIp) {
            throw new Error(`Could not discover IP for VM '${vmName}'`);
          }
          context.logger.info(`VM IP: ${vmIp}. Running k3s-uninstall.sh...`);
          await runSsh(vmKeyFile, vmSshUser, vmIp, `sudo k3s-uninstall.sh`, { allowFailure: true });
          context.logger.info("k3s uninstalled.");
        } finally {
          await Deno.remove(rootKeyFile).catch(() => {});
          await Deno.remove(vmKeyFile).catch(() => {});
        }

        return { dataHandles: [] };
      },
    },
  },
};
