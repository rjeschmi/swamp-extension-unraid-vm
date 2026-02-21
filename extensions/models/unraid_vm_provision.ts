import { z } from "npm:zod@4";
import { makeCloudInitIso } from "./cloud_init_iso.ts";

const UBUNTU_IMAGES = {
  "24.04": "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
  "22.04": "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img",
  "20.04": "https://cloud-images.ubuntu.com/focal/current/focal-server-cloudimg-amd64.img",
};

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe("Unraid SSH hostname or IP"),
  sshUser: z.string().describe("SSH username (root on Unraid)"),
  sshPrivateKey: z.string().describe("SSH private key in PEM format"),
  domainsDir: z.string().describe("VM storage base directory"),
});

const ProvisionArgsSchema = z.object({
  name: z.string().describe("VM name / hostname"),
  cpus: z.number().int().min(1).describe("Number of vCPUs"),
  memoryMiB: z.number().int().min(512).describe("RAM in MiB"),
  diskSizeGb: z.number().int().min(10).describe("Disk size in GB"),
  ubuntuVersion: z.enum(["24.04", "22.04", "20.04"]).describe("Ubuntu version"),
  sshPublicKey: z.string().describe("SSH public key to inject"),
  username: z.string().describe("Unix username to create"),
});

const DestroyArgsSchema = z.object({
  name: z.string().describe("VM name to destroy"),
});

const VmSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  state: z.string(),
  diskPath: z.string(),
  ubuntuVersion: z.string(),
  cpus: z.number(),
  memoryMiB: z.number(),
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

// Write a remote file by base64-encoding content — avoids all shell escaping issues
async function writeRemoteFile(keyFile, user, host, remotePath, content) {
  const b64 = btoa(content);
  await runSsh(keyFile, user, host, `printf '%s' '${b64}' | base64 -d > '${remotePath}'`);
}

// Write a remote binary file (Uint8Array) via base64
async function writeRemoteFileBinary(keyFile, user, host, remotePath, bytes) {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  await runSsh(keyFile, user, host, `printf '%s' '${b64}' | base64 -d > '${remotePath}'`);
}

export const model = {
  type: "@rjeschmi/unraid-vm-provision",
  version: "2026.02.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description: "A provisioned cloud-init Ubuntu VM",
      schema: VmSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    provision: {
      description: "Provision a new Ubuntu cloud-init VM on Unraid via SSH + libvirt",
      arguments: ProvisionArgsSchema,
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, domainsDir } = context.globalArgs;
        const { name, cpus, memoryMiB, diskSizeGb, ubuntuVersion, sshPublicKey, username } = args;

        const imageUrl = UBUNTU_IMAGES[ubuntuVersion];
        const imageName = imageUrl.split("/").pop();
        const cacheDir = `${domainsDir}/.cloud-images`;
        const vmDir = `${domainsDir}/${name}`;

        // Write SSH key to a temp file for the duration of this operation
        const keyFile = `/tmp/.swamp-unraid-${Date.now()}`;
        const keyContent = sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n";
        await Deno.writeTextFile(keyFile, keyContent, { mode: 0o600 });

        const ssh = (cmd, opts) => runSsh(keyFile, sshUser, sshHost, cmd, opts);

        try {
          context.logger.info(`Provisioning ${name}: Ubuntu ${ubuntuVersion}, ${cpus} vCPU, ${memoryMiB}MiB RAM, ${diskSizeGb}GB disk`);

          // 1. Directories
          await ssh(`mkdir -p '${cacheDir}' '${vmDir}'`);
          context.logger.info("Directories ready.");

          // 2. Download cloud image if not cached
          const cached = await ssh(`test -f '${cacheDir}/${imageName}' && echo yes || echo no`, { allowFailure: true });
          if (cached.stdout === "no") {
            context.logger.info(`Downloading Ubuntu ${ubuntuVersion} cloud image (this may take a while)...`);
            await ssh(`wget -q -O '${cacheDir}/${imageName}' '${imageUrl}' || curl -fsSL -o '${cacheDir}/${imageName}' '${imageUrl}'`);
            context.logger.info("Download complete.");
          } else {
            context.logger.info("Using cached cloud image.");
          }

          // 3. Create VM disk (qcow2 backed by cached cloud image — efficient, no full copy)
          context.logger.info(`Creating ${diskSizeGb}GB qcow2 disk...`);
          await ssh(`qemu-img create -f qcow2 -F qcow2 -b '${cacheDir}/${imageName}' '${vmDir}/disk.qcow2' ${diskSizeGb}G`);

          // 4. Build cloud-init seed ISO locally and upload — no remote tools required
          context.logger.info("Building cloud-init seed ISO...");
          const userData = `#cloud-config
hostname: ${name}
users:
  - name: ${username}
    ssh_authorized_keys:
      - ${sshPublicKey}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
package_update: true
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable qemu-guest-agent
  - systemctl start qemu-guest-agent
`;
          const metaData = `instance-id: ${name}\nlocal-hostname: ${name}\n`;

          const isoBytes = makeCloudInitIso(userData, metaData);
          await writeRemoteFileBinary(keyFile, sshUser, sshHost, `${vmDir}/seed.iso`, isoBytes);
          context.logger.info(`Seed ISO uploaded (${isoBytes.length} bytes).`);

          // 5. Resolve emulator path, machine type, and generate UUID in parallel
          context.logger.info("Resolving QEMU emulator, machine type, and UUID...");
          const [emulatorRes, uuidRes, machineRes] = await Promise.all([
            // Get emulator from an existing domain (most reliable — reuses what already works),
            // falling back to the x86_64 entry in virsh capabilities
            ssh(
              `virsh list --all --name 2>/dev/null | grep -v '^$' | head -1 | xargs -r -I{} virsh dumpxml '{}' 2>/dev/null | grep -m1 '<emulator>' | sed 's|.*<emulator>||;s|</emulator>.*||' | grep -v '^$'` +
              ` || virsh capabilities 2>/dev/null | awk '/x86_64/{f=1} f && /<emulator>/{sub(/.*<emulator>/,""); sub(/<\\/emulator>.*/,""); print; exit}'` +
              ` || which qemu-system-x86_64 2>/dev/null || echo /usr/local/sbin/qemu`,
              { allowFailure: true },
            ),
            ssh(`cat /proc/sys/kernel/random/uuid`),
            ssh(`virsh capabilities 2>/dev/null | grep -o 'pc-q35-[0-9.]*' | sort -V | tail -1 || echo pc-q35-8.2`, { allowFailure: true }),
          ]);

          const emulator = emulatorRes.stdout.trim() || "/usr/local/sbin/qemu";
          const uuid = uuidRes.stdout;
          const machine = machineRes.stdout.trim() || "pc-q35-8.2";
          context.logger.info(`Emulator: ${emulator}  Machine: ${machine}  UUID: ${uuid}`);

          // 6. Write libvirt domain XML and define it
          context.logger.info("Defining VM in libvirt...");
          const domainXml = `<domain type='kvm'>
  <name>${name}</name>
  <uuid>${uuid}</uuid>
  <memory unit='MiB'>${memoryMiB}</memory>
  <currentMemory unit='MiB'>${memoryMiB}</currentMemory>
  <vcpu placement='static'>${cpus}</vcpu>
  <os>
    <type arch='x86_64' machine='${machine}'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough' check='none' migratable='on'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>restart</on_crash>
  <devices>
    <emulator>${emulator}</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='writeback'/>
      <source file='${vmDir}/disk.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='${vmDir}/seed.iso'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <interface type='bridge'>
      <source bridge='br0'/>
      <model type='virtio'/>
    </interface>
    <input type='tablet' bus='usb'/>
    <input type='mouse' bus='ps2'/>
    <input type='keyboard' bus='ps2'/>
    <graphics type='vnc' port='-1' autoport='yes' websocket='-1' listen='0.0.0.0' sharePolicy='ignore'>
      <listen type='address' address='0.0.0.0'/>
    </graphics>
    <audio id='1' type='none'/>
    <video>
      <model type='virtio' heads='1' primary='yes'/>
    </video>
    <serial type='pty'>
      <target type='isa-serial' port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
  </devices>
</domain>`;

          await writeRemoteFile(keyFile, sshUser, sshHost, `${vmDir}/domain.xml`, domainXml);
          await ssh(`virsh define '${vmDir}/domain.xml'`);

          // 7. Start VM
          context.logger.info("Starting VM...");
          await ssh(`virsh start '${name}'`);

          context.logger.info(`VM '${name}' provisioned and started. UUID: ${uuid}`);

          const handle = await context.writeResource("vm", name, {
            name, uuid, state: "RUNNING",
            diskPath: `${vmDir}/disk.qcow2`,
            ubuntuVersion, cpus, memoryMiB,
          });

          return { dataHandles: [handle] };
        } finally {
          await Deno.remove(keyFile).catch(() => {});
        }
      },
    },

    restart: {
      description: "Reboot a provisioned VM",
      arguments: z.object({ name: z.string().describe("VM name to restart") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = `/tmp/.swamp-unraid-${Date.now()}`;
        const keyContent = sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n";
        await Deno.writeTextFile(keyFile, keyContent, { mode: 0o600 });
        try {
          context.logger.info(`Restarting VM: ${args.name}`);
          await runSsh(keyFile, sshUser, sshHost, `virsh reboot '${args.name}'`);
          context.logger.info(`VM '${args.name}' is rebooting.`);
        } finally {
          await Deno.remove(keyFile).catch(() => {});
        }
        return { dataHandles: [] };
      },
    },

    dumpXml: {
      description: "Dump the libvirt domain XML for an existing VM (for inspection)",
      arguments: z.object({ name: z.string().describe("VM name to inspect") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = `/tmp/.swamp-unraid-${Date.now()}`;
        const keyContent = sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n";
        await Deno.writeTextFile(keyFile, keyContent, { mode: 0o600 });
        try {
          const result = await runSsh(keyFile, sshUser, sshHost, `virsh dumpxml '${args.name}'`);
          context.logger.info(result.stdout);
        } finally {
          await Deno.remove(keyFile).catch(() => {});
        }
        return { dataHandles: [] };
      },
    },

    destroy: {
      description: "Destroy a provisioned VM and remove its disk files",
      arguments: DestroyArgsSchema,
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, domainsDir } = context.globalArgs;
        const { name } = args;
        const vmDir = `${domainsDir}/${name}`;

        const keyFile = `/tmp/.swamp-unraid-${Date.now()}`;
        const keyContent = sshPrivateKey.endsWith("\n") ? sshPrivateKey : sshPrivateKey + "\n";
        await Deno.writeTextFile(keyFile, keyContent, { mode: 0o600 });

        const ssh = (cmd, opts) => runSsh(keyFile, sshUser, sshHost, cmd, opts);

        try {
          context.logger.info(`Destroying VM: ${name}`);
          await ssh(`virsh destroy '${name}' 2>/dev/null; true`, { allowFailure: true });
          await ssh(`virsh undefine '${name}' --nvram 2>/dev/null || virsh undefine '${name}'`, { allowFailure: true });
          await ssh(`rm -rf '${vmDir}'`);
          context.logger.info(`VM '${name}' destroyed.`);
        } finally {
          await Deno.remove(keyFile).catch(() => {});
        }

        return { dataHandles: [] };
      },
    },
  },
};
