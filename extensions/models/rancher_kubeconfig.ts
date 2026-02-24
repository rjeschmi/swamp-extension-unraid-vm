import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe("Unraid SSH hostname or IP"),
  sshUser: z.string().describe("SSH username (root on Unraid)"),
  sshPrivateKey: z.string().describe("SSH private key for Unraid"),
  vmSshUser: z.string().describe("Username on the VM (created by cloud-init)"),
  vmSshPrivateKey: z.string().describe("SSH private key for the VM user"),
});

const KubeconfigSchema = z.object({
  vmName: z.string(),
  vmIp: z.string(),
  kubeconfig: z.string().describe("Raw kubeconfig YAML with server address rewritten to VM IP"),
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
      "-o", "ServerAliveCountMax=10",
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
  type: "@rjeschmi/rancher-kubeconfig",
  version: "2026.02.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    kubeconfig: {
      description: "k3s kubeconfig fetched from /etc/rancher/k3s/k3s.yaml on the Rancher VM",
      schema: KubeconfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    fetch: {
      description: "Fetch k3s kubeconfig from /etc/rancher/k3s/k3s.yaml on the Rancher VM, rewriting the server address to the VM's real IP",
      arguments: z.object({
        vmName: z.string().describe("VM name used to discover its IP via virsh on Unraid"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, vmSshUser, vmSshPrivateKey } = context.globalArgs;
        const { vmName } = args;

        const rootKeyFile = `/tmp/.swamp-rk-root-${Date.now()}`;
        const vmKeyFile = `/tmp/.swamp-rk-vm-${Date.now()}`;
        await Deno.writeTextFile(rootKeyFile, sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n", { mode: 0o600 });
        await Deno.writeTextFile(vmKeyFile, vmSshPrivateKey.endsWith("\n") ? vmSshPrivateKey : vmSshPrivateKey + "\n", { mode: 0o600 });

        try {
          // Discover VM IP via virsh guest agent on Unraid
          context.logger.info(`Discovering IP for VM '${vmName}' via virsh...`);
          const ipRes = await runSsh(
            rootKeyFile, sshUser, sshHost,
            `virsh domifaddr '${vmName}' --source agent 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | grep -v '^127\\.' | grep -v '^169\\.254\\.' | head -1`,
            { allowFailure: true },
          );
          const vmIp = ipRes.stdout.trim();
          if (!vmIp) {
            throw new Error(`Could not discover IP for VM '${vmName}' — is the VM running and does it have qemu-guest-agent?`);
          }
          context.logger.info(`VM IP: ${vmIp}`);

          // Fetch kubeconfig from the VM
          context.logger.info("Fetching /etc/rancher/k3s/k3s.yaml...");
          const kubeconfigRes = await runSsh(vmKeyFile, vmSshUser, vmIp, "sudo cat /etc/rancher/k3s/k3s.yaml");
          const rawKubeconfig = kubeconfigRes.stdout;

          // Rewrite the server address: k3s defaults to https://127.0.0.1:6443
          const kubeconfig = rawKubeconfig.replace(
            /server:\s*https:\/\/127\.0\.0\.1:/g,
            `server: https://${vmIp}:`,
          );

          context.logger.info("Kubeconfig fetched and server address rewritten.");

          const handle = await context.writeResource("kubeconfig", vmName, {
            vmName,
            vmIp,
            kubeconfig,
          });

          return { dataHandles: [handle] };
        } finally {
          await Deno.remove(rootKeyFile).catch(() => {});
          await Deno.remove(vmKeyFile).catch(() => {});
        }
      },
    },
  },
};
