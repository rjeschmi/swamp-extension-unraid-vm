import { z } from "npm:zod@4";
import { makeCloudInitIso } from "./cloud_init_iso.ts";

const UBUNTU_IMAGES = {
  "24.04":
    "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
  "22.04":
    "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img",
  "20.04":
    "https://cloud-images.ubuntu.com/focal/current/focal-server-cloudimg-amd64.img",
};

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe("Hypervisor SSH hostname or IP"),
  sshUser: z.string().describe("SSH username (e.g. root)"),
  sshPrivateKey: z.string().optional().describe(
    "SSH private key in PEM format (omit to rely on ssh-agent or ~/.ssh/ defaults)",
  ),
  domainsDir: z.string().describe("VM storage base directory"),
});

const MountSchema = z.object({
  hostPath: z.string().describe(
    "Host path to expose (e.g. /mnt/user/home/rob)",
  ),
  tag: z.string().describe(
    "Mount tag — used as the device name when mounting inside the VM",
  ),
  mountPoint: z.string().optional().describe(
    "Path inside the VM to automount via cloud-init (omit to skip)",
  ),
});

const ExtraNicSchema = z.object({
  type: z.enum(["network", "bridge"]).describe(
    "libvirt network or host bridge",
  ),
  name: z.string().describe("Network name (libvirt) or bridge name (host)"),
});

const IsolatedNetworkSchema = z.object({
  name: z.string().describe(
    "Libvirt network name to create if it does not already exist",
  ),
  bridge: z.string().describe(
    "Bridge device name for the isolated network (e.g. virbr-osext)",
  ),
});

const ProvisionArgsSchema = z.object({
  name: z.string().describe("VM name / hostname"),
  cpus: z.number().int().min(1).describe("Number of vCPUs"),
  memoryMiB: z.number().int().min(512).describe("RAM in MiB"),
  diskSizeGb: z.number().int().min(10).describe("Disk size in GB"),
  ubuntuVersion: z.enum(["24.04", "22.04", "20.04"]).describe("Ubuntu version"),
  sshPublicKey: z.string().describe("SSH public key to inject"),
  username: z.string().describe("Unix username to create"),
  managementBridge: z.string().optional().describe(
    "Host bridge for the primary NIC (e.g. br0) — VM gets a real LAN IP. If omitted, managementNetwork is used instead.",
  ),
  managementNetwork: z.string().default("default").describe(
    "Libvirt network for the primary NIC when managementBridge is not set",
  ),
  extraNics: z.array(ExtraNicSchema).optional().describe(
    "Additional NICs to attach (e.g. an isolated Neutron external network)",
  ),
  isolatedNetworks: z.array(IsolatedNetworkSchema).optional().describe(
    "Isolated libvirt networks to create if they do not exist (no DHCP, no NAT)",
  ),
  mounts: z.array(MountSchema).optional().describe(
    "Host paths to expose inside the VM via virtio-9p",
  ),
});

const DestroyArgsSchema = z.object({
  name: z.string().describe("VM name to destroy"),
  keepVm: z.boolean().optional().describe(
    "If true, skip destruction and leave the VM running",
  ),
  removeNetworks: z.array(z.string()).optional().describe(
    "Libvirt network names to remove after destroying the VM",
  ),
});

const VmSchema = z.object({
  name: z.string(),
  uuid: z.string().optional(),
  state: z.string(),
  ip: z.string().optional(),
  diskPath: z.string().optional(),
  ubuntuVersion: z.string().optional(),
  cpus: z.number().optional(),
  memoryMiB: z.number().optional(),
});

const ResultSchema = z.object({
  name: z.string(),
  operation: z.string(),
  success: z.boolean(),
});

const VerifyResultSchema = z.object({
  name: z.string(),
  vmIp: z.string(),
  hostname: z.string(),
  username: z.string(),
  cloudInitStatus: z.string(),
  passed: z.boolean(),
});

const dec = new TextDecoder();

async function setupKeyFile(privateKey?: string): Promise<string | null> {
  if (!privateKey) return null;
  const path = `/tmp/.swamp-unraid-${Date.now()}`;
  const content = privateKey.endsWith("\n") ? privateKey : privateKey + "\n";
  await Deno.writeTextFile(path, content, { mode: 0o600 });
  return path;
}

async function cleanupKeyFile(path: string | null) {
  if (path) await Deno.remove(path).catch(() => {});
}

async function runSsh(
  keyFile,
  user,
  host,
  command,
  { allowFailure = false } = {},
) {
  const keyArgs = keyFile ? ["-i", keyFile] : [];
  const proc = new Deno.Command("ssh", {
    args: [
      ...keyArgs,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
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
    throw new Error(
      `SSH failed (exit ${result.code}):\n$ ${command}\nstderr: ${stderr}`,
    );
  }
  return { stdout, stderr, code: result.code };
}

async function writeRemoteFile(keyFile, user, host, remotePath, content) {
  const b64 = btoa(content);
  await runSsh(
    keyFile,
    user,
    host,
    `printf '%s' '${b64}' | base64 -d > '${remotePath}'`,
  );
}

async function writeRemoteFileBinary(keyFile, user, host, remotePath, bytes) {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  await runSsh(
    keyFile,
    user,
    host,
    `printf '%s' '${b64}' | base64 -d > '${remotePath}'`,
  );
}

export const model = {
  type: "@rjeschmi/virsh-ssh-vm-provision",
  version: "2026.03.03.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description: "A provisioned cloud-init Ubuntu VM",
      schema: VmSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    verifyResult: {
      description: "Result of a cloud-init verification run",
      schema: VerifyResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    result: {
      description: "Result of the most recent VM control operation",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    provision: {
      description:
        "Provision a new Ubuntu cloud-init VM via SSH + libvirt. Supports multiple NICs and isolated network creation.",
      arguments: ProvisionArgsSchema,
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, domainsDir } =
          context.globalArgs;
        const {
          name,
          cpus,
          memoryMiB,
          diskSizeGb,
          ubuntuVersion,
          sshPublicKey,
          username,
          managementBridge,
          managementNetwork,
          extraNics = [],
          isolatedNetworks = [],
          mounts = [],
        } = args;

        const imageUrl = UBUNTU_IMAGES[ubuntuVersion];
        const imageName = imageUrl.split("/").pop();
        const cacheDir = `${domainsDir}/.cloud-images`;
        const vmDir = `${domainsDir}/${name}`;

        const keyFile = await setupKeyFile(sshPrivateKey);
        const ssh = (cmd, opts?) =>
          runSsh(keyFile, sshUser, sshHost, cmd, opts);

        try {
          context.logger.info(
            `Provisioning ${name}: Ubuntu ${ubuntuVersion}, ${cpus} vCPU, ${memoryMiB}MiB RAM, ${diskSizeGb}GB disk`,
          );

          // 1. Create any isolated networks that don't exist yet
          for (const net of isolatedNetworks) {
            context.logger.info(
              `Checking for isolated libvirt network '${net.name}'...`,
            );
            const check = await ssh(
              `virsh net-info '${net.name}' 2>/dev/null && echo exists || echo missing`,
              { allowFailure: true },
            );
            if (check.stdout.includes("missing")) {
              context.logger.info(
                `Creating isolated libvirt network '${net.name}' (bridge: ${net.bridge})...`,
              );
              const xml =
                `<network>\n  <name>${net.name}</name>\n  <bridge name='${net.bridge}'/>\n</network>`;
              await writeRemoteFile(
                keyFile,
                sshUser,
                sshHost,
                `/tmp/${net.name}.xml`,
                xml,
              );
              await ssh(`virsh net-define /tmp/${net.name}.xml`);
              await ssh(`virsh net-start '${net.name}'`);
              await ssh(`virsh net-autostart '${net.name}'`);
              context.logger.info(`Network '${net.name}' created.`);
            } else {
              const active = await ssh(
                `virsh net-info '${net.name}' | awk '/Active:/{print $2}'`,
                { allowFailure: true },
              );
              if (active.stdout.trim() !== "yes") {
                await ssh(`virsh net-start '${net.name}'`, {
                  allowFailure: true,
                });
              }
              context.logger.info(`Network '${net.name}' already exists.`);
            }
          }

          // 2. Directories
          await ssh(`mkdir -p '${cacheDir}' '${vmDir}'`);
          context.logger.info("Directories ready.");

          // 3. Download cloud image if not cached
          const cached = await ssh(
            `test -f '${cacheDir}/${imageName}' && echo yes || echo no`,
            { allowFailure: true },
          );
          if (cached.stdout === "no") {
            context.logger.info(
              `Downloading Ubuntu ${ubuntuVersion} cloud image (this may take a while)...`,
            );
            await ssh(
              `wget -q -O '${cacheDir}/${imageName}' '${imageUrl}' || curl -fsSL -o '${cacheDir}/${imageName}' '${imageUrl}'`,
            );
            context.logger.info("Download complete.");
          } else {
            context.logger.info("Using cached cloud image.");
          }

          // 4. Create VM disk (qcow2 backed by cached cloud image)
          context.logger.info(`Creating ${diskSizeGb}GB qcow2 disk...`);
          await ssh(
            `qemu-img create -f qcow2 -F qcow2 -b '${cacheDir}/${imageName}' '${vmDir}/disk.qcow2' ${diskSizeGb}G`,
          );

          // 5. Build cloud-init seed ISO
          context.logger.info("Building cloud-init seed ISO...");
          const mountsWithPoint = mounts.filter((m) => m.mountPoint);
          const mountsSection = mountsWithPoint.length > 0
            ? `mounts:\n${
              mountsWithPoint.map((m) =>
                `  - [${m.tag}, ${m.mountPoint}, 9p, "trans=virtio,rw,nofail", 0, 0]`
              ).join("\n")
            }\n`
            : "";
          const mkdirCmds = mountsWithPoint.map((m) =>
            `  - mkdir -p '${m.mountPoint}'`
          ).join("\n");

          const userData = `#cloud-config
hostname: ${name}
users:
  - name: ${username}
    ssh_authorized_keys:
      - ${sshPublicKey}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
package_update: false
packages:
  - qemu-guest-agent
${mountsSection}runcmd:
  - systemctl enable --now qemu-guest-agent
${mkdirCmds}
`;
          const metaData = `instance-id: ${name}\nlocal-hostname: ${name}\n`;
          const isoBytes = makeCloudInitIso(userData, metaData);
          await writeRemoteFileBinary(
            keyFile,
            sshUser,
            sshHost,
            `${vmDir}/seed.iso`,
            isoBytes,
          );
          context.logger.info(`Seed ISO uploaded (${isoBytes.length} bytes).`);

          // 6. Resolve emulator path, machine type, and UUID
          context.logger.info(
            "Resolving QEMU emulator, machine type, and UUID...",
          );
          const [emulatorRes, uuidRes, machineRes] = await Promise.all([
            ssh(
              `virsh list --all --name 2>/dev/null | grep -v '^$' | head -1 | xargs -r -I{} virsh dumpxml '{}' 2>/dev/null | grep -m1 '<emulator>' | sed 's|.*<emulator>||;s|</emulator>.*||' | grep -v '^$'` +
                ` || virsh capabilities 2>/dev/null | awk '/x86_64/{f=1} f && /<emulator>/{sub(/.*<emulator>/,""); sub(/<\\/emulator>.*/,""); print; exit}'` +
                ` || which qemu-system-x86_64 2>/dev/null || echo /usr/local/sbin/qemu`,
              { allowFailure: true },
            ),
            ssh(`cat /proc/sys/kernel/random/uuid`),
            ssh(
              `virsh capabilities 2>/dev/null | grep -o 'pc-q35-[0-9.]*' | sort -V | tail -1 || echo pc-q35-8.2`,
              { allowFailure: true },
            ),
          ]);

          const emulator = emulatorRes.stdout.trim() || "/usr/local/sbin/qemu";
          const uuid = uuidRes.stdout;
          const machine = machineRes.stdout.trim() || "pc-q35-8.2";
          context.logger.info(
            `Emulator: ${emulator}  Machine: ${machine}  UUID: ${uuid}`,
          );

          // 7. Build NIC XML — primary NIC (bridge or libvirt network) + any extra NICs
          const primaryNicXml = managementBridge
            ? `<interface type='bridge'>\n      <source bridge='${managementBridge}'/>\n      <model type='virtio'/>\n    </interface>`
            : `<interface type='network'>\n      <source network='${managementNetwork}'/>\n      <model type='virtio'/>\n    </interface>`;

          const extraNicsXml = extraNics.map((nic) =>
            nic.type === "bridge"
              ? `<interface type='bridge'>\n      <source bridge='${nic.name}'/>\n      <model type='virtio'/>\n    </interface>`
              : `<interface type='network'>\n      <source network='${nic.name}'/>\n      <model type='virtio'/>\n    </interface>`
          ).join("\n    ");

          // 8. Write libvirt domain XML and define it
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
    ${primaryNicXml}
    ${extraNicsXml}
    <input type='tablet' bus='usb'/>
    <input type='mouse' bus='ps2'/>
    <input type='keyboard' bus='ps2'/>
    <serial type='pty'>
      <target type='isa-serial' port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
${
            mounts.map((m) =>
              `    <filesystem type='mount' accessmode='passthrough'>
      <source dir='${m.hostPath}'/>
      <target dir='${m.tag}'/>
    </filesystem>`
            ).join("\n")
          }
  </devices>
</domain>`;

          await writeRemoteFile(
            keyFile,
            sshUser,
            sshHost,
            `${vmDir}/domain.xml`,
            domainXml,
          );
          await ssh(`virsh define '${vmDir}/domain.xml'`);

          // 9. Start VM and poll for IP via guest agent
          context.logger.info("Starting VM...");
          await ssh(`virsh start '${name}'`);
          context.logger.info(
            `VM '${name}' started. Polling for IP via guest agent (up to 5 min)...`,
          );

          const deadline = Date.now() + 300_000;
          let vmIp: string | null = null;
          while (Date.now() < deadline) {
            const res = await ssh(
              `virsh domifaddr '${name}' --source agent 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | grep -v '^127\\.' | grep -v '^169\\.254\\.' | head -1`,
              { allowFailure: true },
            );
            if (res.stdout && res.stdout.trim() !== "") {
              vmIp = res.stdout.trim();
              context.logger.info(`VM IP: ${vmIp}`);
              break;
            }
            context.logger.info(
              "Waiting for guest agent IP (cloud-init running)...",
            );
            await new Promise((r) => setTimeout(r, 15_000));
          }

          if (!vmIp) {
            throw new Error(
              `VM '${name}' did not get an IP within 5 minutes. Check: virsh domifaddr ${name} --source agent`,
            );
          }

          context.logger.info(
            `VM '${name}' provisioned — IP: ${vmIp}  User: ${username}`,
          );

          const handle = await context.writeResource("vm", name, {
            name,
            uuid,
            state: "RUNNING",
            ip: vmIp,
            diskPath: `${vmDir}/disk.qcow2`,
            ubuntuVersion,
            cpus,
            memoryMiB,
          });

          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    restart: {
      description: "Reboot a provisioned VM",
      arguments: z.object({ name: z.string().describe("VM name to restart") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          context.logger.info(`Restarting VM: ${args.name}`);
          await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh reboot '${args.name}'`,
          );
          context.logger.info(`VM '${args.name}' is rebooting.`);
        } finally {
          await cleanupKeyFile(keyFile);
        }
        return { dataHandles: [] };
      },
    },

    dumpXml: {
      description:
        "Dump the libvirt domain XML for an existing VM (for inspection)",
      arguments: z.object({ name: z.string().describe("VM name to inspect") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          const result = await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh dumpxml '${args.name}'`,
          );
          context.logger.info(result.stdout);
        } finally {
          await cleanupKeyFile(keyFile);
        }
        return { dataHandles: [] };
      },
    },

    verify: {
      description:
        "Wait for a provisioned VM to boot and verify cloud-init completed successfully",
      arguments: z.object({
        name: z.string().describe("VM name to verify"),
        expectedHostname: z.string().describe(
          "Expected hostname after cloud-init",
        ),
        expectedUsername: z.string().describe(
          "Expected Unix username created by cloud-init",
        ),
        userSshPrivateKey: z.string().optional().describe(
          "Private SSH key for the provisioned user (omit to rely on ssh-agent or ~/.ssh/ defaults)",
        ),
        timeoutSeconds: z.number().int().min(30).optional().describe(
          "Max seconds to wait for VM to boot (default 300)",
        ),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const { name, expectedHostname, expectedUsername, userSshPrivateKey } =
          args;
        const timeoutMs = (args.timeoutSeconds ?? 300) * 1000;
        const pollInterval = 10_000;

        const rootKeyFile = await setupKeyFile(sshPrivateKey);
        const userKeyFile = await setupKeyFile(userSshPrivateKey);
        const rootSsh = (cmd, opts?) =>
          runSsh(rootKeyFile, sshUser, sshHost, cmd, opts);

        let vmIp: string | null = null;

        try {
          context.logger.info(
            `Waiting for VM '${name}' to boot (timeout: ${
              args.timeoutSeconds ?? 300
            }s)...`,
          );
          const deadline = Date.now() + timeoutMs;

          while (Date.now() < deadline) {
            const res = await rootSsh(
              `virsh domifaddr '${name}' --source agent 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | grep -v '^127\\.' | grep -v '^169\\.254\\.' | head -1`,
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
            throw new Error(
              `VM '${name}' did not get an IP within ${
                args.timeoutSeconds ?? 300
              }s`,
            );
          }

          let sshReady = false;
          while (Date.now() < deadline) {
            const res = await runSsh(
              userKeyFile,
              expectedUsername,
              vmIp,
              "echo ready",
              { allowFailure: true },
            );
            if (res.code === 0 && res.stdout.trim() === "ready") {
              sshReady = true;
              break;
            }
            context.logger.info("SSH not ready yet, retrying in 10s...");
            await new Promise((r) => setTimeout(r, pollInterval));
          }

          if (!sshReady) {
            throw new Error(
              `VM '${name}' (${vmIp}) SSH not available within timeout`,
            );
          }

          context.logger.info("SSH ready. Running cloud-init verification...");

          const [hostnameRes, userRes, ciRes] = await Promise.all([
            runSsh(userKeyFile, expectedUsername, vmIp, "hostname"),
            runSsh(
              userKeyFile,
              expectedUsername,
              vmIp,
              `id ${expectedUsername}`,
              { allowFailure: true },
            ),
            runSsh(
              userKeyFile,
              expectedUsername,
              vmIp,
              'sudo cloud-init status --wait --format json 2>/dev/null || echo \'{"status":"unknown"}\'',
              { allowFailure: true },
            ),
          ]);

          const actualHostname = hostnameRes.stdout.trim();
          let cloudInitStatus = "unknown";
          try {
            cloudInitStatus = JSON.parse(ciRes.stdout).status ?? "unknown";
          } catch {
            cloudInitStatus = ciRes.stdout.trim() || "unknown";
          }

          context.logger.info(
            `hostname: expected='${expectedHostname}' actual='${actualHostname}'`,
          );
          context.logger.info(
            `user '${expectedUsername}': ${
              userRes.code === 0 ? "exists" : "NOT FOUND"
            }`,
          );
          context.logger.info(`cloud-init status: ${cloudInitStatus}`);

          const passed = actualHostname === expectedHostname &&
            userRes.code === 0 && cloudInitStatus === "done";

          if (!passed) {
            const reasons = [];
            if (actualHostname !== expectedHostname) {
              reasons.push(
                `hostname: got '${actualHostname}', expected '${expectedHostname}'`,
              );
            }
            if (userRes.code !== 0) {
              reasons.push(`user '${expectedUsername}' not found`);
            }
            if (cloudInitStatus !== "done") {
              reasons.push(
                `cloud-init status '${cloudInitStatus}' (expected 'done')`,
              );
            }
            throw new Error(`Verification failed: ${reasons.join("; ")}`);
          }

          context.logger.info(`VM '${name}' verification passed.`);

          const handle = await context.writeResource("verifyResult", name, {
            name,
            vmIp,
            hostname: actualHostname,
            username: expectedUsername,
            cloudInitStatus,
            passed,
          });
          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(rootKeyFile);
          await cleanupKeyFile(userKeyFile);
        }
      },
    },

    list: {
      description: "List all virtual machines defined in libvirt",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          const res = await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh list --all 2>/dev/null`,
          );
          const lines = res.stdout.split("\n").slice(2);
          const handles = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parts = trimmed.split(/\s+/);
            if (parts.length < 3) continue;
            const name = parts[1];
            const state = parts.slice(2).join(" ");
            context.logger.info(`  ${name}  state=${state}`);
            const handle = await context.writeResource("vm", name, {
              name,
              state,
            });
            handles.push(handle);
          }
          context.logger.info(`Found ${handles.length} VM(s)`);
          return { dataHandles: handles };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    start: {
      description: "Start a VM via virsh",
      arguments: z.object({ name: z.string().describe("VM name to start") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          await runSsh(keyFile, sshUser, sshHost, `virsh start '${args.name}'`);
          context.logger.info(`Started VM '${args.name}'`);
          const handle = await context.writeResource("result", "latest", {
            name: args.name,
            operation: "start",
            success: true,
          });
          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    stop: {
      description: "Gracefully stop a VM via ACPI signal (virsh shutdown)",
      arguments: z.object({ name: z.string().describe("VM name to stop") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh shutdown '${args.name}'`,
          );
          context.logger.info(`Sent ACPI shutdown to VM '${args.name}'`);
          const handle = await context.writeResource("result", "latest", {
            name: args.name,
            operation: "stop",
            success: true,
          });
          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    forceStop: {
      description: "Force power off a VM immediately (virsh destroy)",
      arguments: z.object({
        name: z.string().describe("VM name to force-stop"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh destroy '${args.name}'`,
          );
          context.logger.info(`Force-stopped VM '${args.name}'`);
          const handle = await context.writeResource("result", "latest", {
            name: args.name,
            operation: "forceStop",
            success: true,
          });
          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    pause: {
      description: "Pause (suspend) a running VM",
      arguments: z.object({ name: z.string().describe("VM name to pause") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh suspend '${args.name}'`,
          );
          context.logger.info(`Paused VM '${args.name}'`);
          const handle = await context.writeResource("result", "latest", {
            name: args.name,
            operation: "pause",
            success: true,
          });
          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    resume: {
      description: "Resume a paused VM",
      arguments: z.object({ name: z.string().describe("VM name to resume") }),
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey } = context.globalArgs;
        const keyFile = await setupKeyFile(sshPrivateKey);
        try {
          await runSsh(
            keyFile,
            sshUser,
            sshHost,
            `virsh resume '${args.name}'`,
          );
          context.logger.info(`Resumed VM '${args.name}'`);
          const handle = await context.writeResource("result", "latest", {
            name: args.name,
            operation: "resume",
            success: true,
          });
          return { dataHandles: [handle] };
        } finally {
          await cleanupKeyFile(keyFile);
        }
      },
    },

    destroy: {
      description:
        "Destroy a VM, remove its disk files, and optionally remove libvirt networks",
      arguments: DestroyArgsSchema,
      execute: async (args, context) => {
        const { sshHost, sshUser, sshPrivateKey, domainsDir } =
          context.globalArgs;
        const { name, keepVm, removeNetworks = [] } = args;

        if (keepVm) {
          context.logger.info(
            `Skipping destroy for VM '${name}' (keepVm=true). VM is still running.`,
          );
          return { dataHandles: [] };
        }

        const vmDir = `${domainsDir}/${name}`;
        const keyFile = await setupKeyFile(sshPrivateKey);
        const ssh = (cmd, opts?) =>
          runSsh(keyFile, sshUser, sshHost, cmd, opts);

        try {
          context.logger.info(`Destroying VM: ${name}`);
          await ssh(`virsh destroy '${name}' 2>/dev/null; true`, {
            allowFailure: true,
          });
          await ssh(
            `virsh undefine '${name}' --nvram 2>/dev/null || virsh undefine '${name}'`,
            { allowFailure: true },
          );
          await ssh(`rm -rf '${vmDir}'`);
          context.logger.info(`VM '${name}' destroyed.`);

          for (const net of removeNetworks) {
            context.logger.info(`Removing libvirt network '${net}'...`);
            await ssh(`virsh net-destroy '${net}' 2>/dev/null; true`, {
              allowFailure: true,
            });
            await ssh(`virsh net-undefine '${net}' 2>/dev/null; true`, {
              allowFailure: true,
            });
            context.logger.info(`Network '${net}' removed.`);
          }
        } finally {
          await cleanupKeyFile(keyFile);
        }

        return { dataHandles: [] };
      },
    },
  },
};
