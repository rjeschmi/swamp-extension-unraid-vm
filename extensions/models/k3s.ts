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
  type: "@rjeschmi/k3s",
  version: "2026.02.23.1",
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
      description: "Install k3s on a provisioned VM via SSH and wait for the node to be ready",
      arguments: z.object({
        vmName: z.string().describe("VM name, used to discover IP via virsh"),
        timeoutSeconds: z.number().int().optional().describe("Max seconds to wait (default: 600)"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, vmSshUser, vmSshPrivateKey } = context.globalArgs;
        const { vmName } = args;
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
          context.logger.info(`Installing k3s on VM '${vmName}'...`);
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

          // 3. Install k3s
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

          // Detect k3s version
          const k3sVersionRes = await vmSsh(`k3s --version | head -1`, { allowFailure: true });
          const k3sVersion = k3sVersionRes.stdout.replace(/^k3s version /, "").split(" ")[0] || "unknown";

          context.logger.info(`k3s ${k3sVersion} ready on ${vmIp}`);

          const handle = await context.writeResource("cluster", vmName, {
            vmName,
            vmIp,
            k3sVersion,
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
