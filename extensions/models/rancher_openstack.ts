import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  rancherUrl: z.string().describe("Rancher server URL (e.g. https://rancher.example.com)"),
  rancherToken: z.string().describe("Rancher API bearer token (e.g. token-xxxxx:yyyyyyyyy)"),
  insecure: z.boolean().optional().describe("Skip TLS certificate verification (for self-signed certs)"),
});

const CredentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

const NodeTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  flavorName: z.string(),
  image: z.string(),
  networkName: z.string(),
  credentialId: z.string(),
});

const ClusterSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  kubernetesVersion: z.string(),
  nodeCount: z.number(),
});

const SSH_KEY_DIR = "/Users/rob/swamp/ssh_debug";

const dec = new TextDecoder();

async function rancherRequest(rancherUrl, token, method, path, body, insecure = false) {
  const url = `${rancherUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-s", "-S",
    "-X", method,
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json",
    "-w", "\n__STATUS__%{http_code}",
  ];
  if (insecure) args.push("-k");
  if (body != null) args.push("-d", JSON.stringify(body));
  args.push(url);

  const proc = new Deno.Command("curl", { args, stdout: "piped", stderr: "piped" });
  const result = await proc.output();
  const raw = dec.decode(result.stdout);
  const stderr = dec.decode(result.stderr).trim();

  if (result.code !== 0) {
    throw new Error(`Rancher API ${method} ${path} failed: ${stderr || raw}`);
  }

  const statusMatch = raw.match(/\n__STATUS__(\d+)$/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 0;
  const text = statusMatch ? raw.slice(0, raw.lastIndexOf("\n__STATUS__")) : raw;

  if (status < 200 || status >= 300) {
    throw new Error(`Rancher API ${method} ${path} failed (${status}): ${text}`);
  }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function scheduleClusterDelete(rancherUrl, rancherToken, clusterName, delayHours, insecure, logger) {
  const safeName = clusterName.replace(/[^a-z0-9-]/g, "-");
  const cronJobName = `ttl-delete-${safeName}`;
  const secretName = `ttl-token-${safeName}`;
  const ns = "default";
  const insecureFlag = insecure ? "-k" : "";

  const deleteAtEpoch = Math.floor(Date.now() / 1000) + delayHours * 3600;
  const deleteAtISO = new Date(deleteAtEpoch * 1000).toISOString();
  logger.info(`Scheduling deletion of '${clusterName}' at ${deleteAtISO} (in ${delayHours}h) via CronJob '${cronJobName}'...`);

  const secretBody = {
    apiVersion: "v1", kind: "Secret",
    metadata: { name: secretName, namespace: ns, labels: { "swamp/ttl-delete": "true", "swamp/cluster": safeName } },
    stringData: { RANCHER_TOKEN: rancherToken, DELETE_AT: String(deleteAtEpoch) },
  };
  await rancherRequest(rancherUrl, rancherToken, "DELETE",
    `/k8s/clusters/local/api/v1/namespaces/${ns}/secrets/${secretName}`, null, insecure).catch(() => {});
  await rancherRequest(rancherUrl, rancherToken, "POST",
    `/k8s/clusters/local/api/v1/namespaces/${ns}/secrets`, secretBody, insecure);

  await rancherRequest(rancherUrl, rancherToken, "DELETE",
    `/k8s/clusters/local/apis/batch/v1/namespaces/${ns}/cronjobs/${cronJobName}`,
    { propagationPolicy: "Foreground" }, insecure).catch(() => {});

  const script = [
    `NOW=$(date +%s)`,
    `echo "Current time: $NOW, delete at: $DELETE_AT"`,
    `if [ "$NOW" -lt "$DELETE_AT" ]; then echo "Not yet time to delete. Exiting."; exit 0; fi`,
    `echo "TTL expired. Deleting cluster '${clusterName}'..."`,
    `STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${rancherUrl}/v1/provisioning.cattle.io.clusters/fleet-default/${clusterName}" -H "Authorization: Bearer $RANCHER_TOKEN" ${insecureFlag})`,
    `echo "Rancher API responded: $STATUS"`,
    `if [ "$STATUS" = "200" ] || [ "$STATUS" = "204" ] || [ "$STATUS" = "404" ]; then echo "Cluster deleted or already gone. Cleaning up CronJob..."; curl -s -o /dev/null -X DELETE "${rancherUrl}/k8s/clusters/local/apis/batch/v1/namespaces/${ns}/cronjobs/${cronJobName}" -H "Authorization: Bearer $RANCHER_TOKEN" ${insecureFlag}; curl -s -o /dev/null -X DELETE "${rancherUrl}/k8s/clusters/local/api/v1/namespaces/${ns}/secrets/${secretName}" -H "Authorization: Bearer $RANCHER_TOKEN" ${insecureFlag}; fi`,
  ].join(" && ");

  const cronJobBody = {
    apiVersion: "batch/v1", kind: "CronJob",
    metadata: { name: cronJobName, namespace: ns, labels: { "swamp/ttl-delete": "true", "swamp/cluster": safeName } },
    spec: {
      schedule: "*/15 * * * *",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          ttlSecondsAfterFinished: 300,
          template: {
            metadata: { labels: { "swamp/ttl-delete": "true", "swamp/cluster": safeName } },
            spec: {
              restartPolicy: "Never",
              containers: [{
                name: "delete",
                image: "curlimages/curl:latest",
                command: ["sh", "-c", script],
                env: [
                  { name: "RANCHER_TOKEN", valueFrom: { secretKeyRef: { name: secretName, key: "RANCHER_TOKEN" } } },
                  { name: "DELETE_AT", valueFrom: { secretKeyRef: { name: secretName, key: "DELETE_AT" } } },
                ],
              }],
            },
          },
        },
      },
    },
  };
  await rancherRequest(rancherUrl, rancherToken, "POST",
    `/k8s/clusters/local/apis/batch/v1/namespaces/${ns}/cronjobs`, cronJobBody, insecure);

  logger.info(`CronJob '${cronJobName}' created. Cluster '${clusterName}' will be deleted after ${deleteAtISO}.`);
}

async function installTailscaleOperator(rancherUrl, rancherToken, mgmtClusterId, clientId, clientSecret, insecure, logger) {
  logger.info(`Fetching kubeconfig for cluster '${mgmtClusterId}'...`);
  const kubeconfigData = await rancherRequest(rancherUrl, rancherToken, "POST",
    `/v3/clusters/${mgmtClusterId}?action=generateKubeconfig`, {}, insecure);
  const kubeconfig = kubeconfigData.config;
  if (!kubeconfig) throw new Error("generateKubeconfig returned no config");

  const tmpKubeconfig = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(tmpKubeconfig, kubeconfig);

    const env = { ...Deno.env.toObject(), KUBECONFIG: tmpKubeconfig };

    // Add tailscale helm repo
    logger.info("Adding tailscale helm repo...");
    const repoAdd = new Deno.Command("helm", {
      args: ["repo", "add", "tailscale", "https://pkgs.tailscale.com/helmcharts"],
      env, stdout: "piped", stderr: "piped",
    });
    const repoResult = await repoAdd.output();
    logger.info(dec.decode(repoResult.stdout) + dec.decode(repoResult.stderr));

    const repoUpdate = new Deno.Command("helm", {
      args: ["repo", "update"],
      env, stdout: "piped", stderr: "piped",
    });
    await repoUpdate.output();

    // Install tailscale-operator
    logger.info("Installing tailscale-operator...");
    const helmInstall = new Deno.Command("helm", {
      args: [
        "upgrade", "--install", "tailscale-operator", "tailscale/tailscale-operator",
        "--namespace", "tailscale",
        "--create-namespace",
        "--set", `oauth.clientId=${clientId}`,
        "--set", `oauth.clientSecret=${clientSecret}`,
        "--wait", "--timeout", "600s",
      ],
      env, stdout: "piped", stderr: "piped",
    });
    const installResult = await helmInstall.output();
    const stdout = dec.decode(installResult.stdout);
    const stderr = dec.decode(installResult.stderr);
    logger.info(stdout + stderr);
    if (installResult.code !== 0) {
      throw new Error(`helm install tailscale-operator failed: ${stderr}`);
    }
    logger.info("tailscale-operator installed successfully.");
  } finally {
    await Deno.remove(tmpKubeconfig).catch(() => {});
  }
}

async function fetchAndSaveSshKeys(rancherUrl, rancherToken, clusterName, insecure, logger) {
  const namespace = "fleet-default";
  const savedKeys = [];

  // List CAPI machines for this cluster
  logger.info(`Fetching CAPI machines for cluster '${clusterName}'...`);
  let machines;
  try {
    machines = await rancherRequest(rancherUrl, rancherToken, "GET",
      `/v1/cluster.x-k8s.io.machines/${namespace}`, null, insecure);
  } catch (err) {
    logger.info(`Failed to list CAPI machines: ${err.message}`);
    return savedKeys;
  }

  const allMachines = machines.data ?? [];
  logger.info(`Total CAPI machines in namespace: ${allMachines.length}`);
  for (const m of allMachines) {
    logger.info(`  machine: ${m.metadata?.name} cluster: ${m.spec?.clusterName}`);
  }

  const clusterMachines = allMachines.filter(
    (m) => m.spec?.clusterName === clusterName,
  );
  logger.info(`Found ${clusterMachines.length} machine(s) for cluster '${clusterName}'.`);

  for (const machine of clusterMachines) {
    const machineName = machine.metadata?.name ?? "unknown";
    const infraRef = machine.spec?.infrastructureRef;
    logger.info(`Machine '${machineName}' infraRef: ${JSON.stringify(infraRef)}`);

    // Try to find the machine-state secret via the infrastructure machine name
    // For RKE2/CAPI, secrets follow: <infra-machine-name>-machine-state
    const infraMachineName = infraRef?.name ?? machineName;
    const secretName = `${infraMachineName}-machine-state`;

    try {
      logger.info(`Looking for secret: ${namespace}/${secretName}`);
      const secret = await rancherRequest(rancherUrl, rancherToken, "GET",
        `/v1/secrets/${namespace}/${secretName}`, null, insecure);

      // Log available keys in the secret
      const secretKeys = Object.keys(secret.data ?? {});
      logger.info(`Secret '${secretName}' has keys: ${secretKeys.join(", ")}`);

      // Try multiple approaches to find the SSH key
      let sshKey = "";

      // Approach 1: Direct "sshkey" field in secret data
      if (secret.data?.["sshkey"]) {
        sshKey = atob(secret.data["sshkey"]);
        logger.info(`Found SSH key in 'sshkey' field (${sshKey.length} bytes)`);
      }

      // Approach 2: Extract from machine-state JSON
      if (!sshKey && secret.data?.["machine-state"]) {
        try {
          const stateJson = atob(secret.data["machine-state"]);
          const state = JSON.parse(stateJson);
          logger.info(`machine-state driver keys: ${Object.keys(state?.Driver ?? state?.driver ?? {}).join(", ")}`);

          // Docker Machine / Rancher Machine stores key path or content
          const driver = state?.Driver ?? state?.driver ?? {};
          if (driver.SSHKey) {
            sshKey = driver.SSHKey;
            logger.info(`Found SSH key in Driver.SSHKey (${sshKey.length} bytes)`);
          } else if (driver.SSHKeyPath) {
            logger.info(`SSH key referenced at path: ${driver.SSHKeyPath} (not extractable from API)`);
          }
        } catch (parseErr) {
          logger.info(`Failed to parse machine-state: ${parseErr.message}`);
        }
      }

      // Approach 3: Look for any key-like field
      if (!sshKey) {
        for (const key of secretKeys) {
          if (key.toLowerCase().includes("ssh") || key.toLowerCase().includes("key") || key.toLowerCase().includes("private")) {
            const val = atob(secret.data[key]);
            if (val.includes("PRIVATE KEY")) {
              sshKey = val;
              logger.info(`Found SSH key in field '${key}' (${sshKey.length} bytes)`);
              break;
            }
          }
        }
      }

      if (!sshKey) {
        logger.info(`No SSH key found for machine '${machineName}' — skipping.`);
        continue;
      }

      // Save to disk
      const keyDir = `${SSH_KEY_DIR}/${machineName}`;
      const keyPath = `${keyDir}/id_rsa`;

      await new Deno.Command("mkdir", { args: ["-p", keyDir] }).output();
      await Deno.writeTextFile(keyPath, sshKey);
      await Deno.chmod(keyDir, 0o700);
      await Deno.chmod(keyPath, 0o600);

      savedKeys.push({ nodeName: machineName, keyPath });
      logger.info(`SSH key saved: ${keyPath}`);
    } catch (err) {
      logger.info(`Could not fetch SSH key for machine '${machineName}': ${err.message}`);
    }
  }

  return savedKeys;
}

export const model = {
  type: "@rjeschmi/rancher-openstack",
  version: "2026.02.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    credential: {
      description: "OpenStack cloud credentials stored in Rancher",
      schema: CredentialSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    nodeTemplate: {
      description: "OpenStack node template in Rancher",
      schema: NodeTemplateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cluster: {
      description: "RKE cluster provisioned on OpenStack via Rancher",
      schema: ClusterSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    createCredential: {
      description: "Create OpenStack cloud credentials in Rancher",
      arguments: z.object({
        name: z.string().describe("Credential name in Rancher"),
        authUrl: z.string().describe("OpenStack Keystone auth URL"),
        username: z.string().describe("OpenStack username"),
        password: z.string().describe("OpenStack password"),
        domainName: z.string().optional().describe("OpenStack domain name (default: Default)"),
        tenantName: z.string().describe("OpenStack project/tenant name"),
        region: z.string().optional().describe("OpenStack region"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;
        const { name, authUrl, username, password, domainName, tenantName, region } = args;

        context.logger.info(`Creating OpenStack cloud credential '${name}' in Rancher...`);

        const cred = await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/cloudcredentials", {
          name,
          openstackcredentialConfig: { password },
        }, insecure);

        context.logger.info(`Credential '${name}' created with ID: ${cred.id}`);

        const handle = await context.writeResource("credential", name, {
          id: cred.id,
          name: cred.name ?? name,
          createdAt: cred.created ?? new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },

    createNodeTemplate: {
      description: "Create an OpenStack node template in Rancher",
      arguments: z.object({
        name: z.string().describe("Node template name"),
        credentialId: z.string().describe("Cloud credential ID (from createCredential output)"),
        authUrl: z.string().describe("OpenStack Keystone auth URL"),
        username: z.string().describe("OpenStack username"),
        password: z.string().describe("OpenStack password"),
        tenantName: z.string().describe("OpenStack project/tenant name"),
        domainName: z.string().optional().describe("OpenStack domain name (default: Default)"),
        region: z.string().optional().describe("OpenStack region"),
        flavorName: z.string().describe("OpenStack flavor (e.g. m1.medium)"),
        imageName: z.string().optional().describe("OpenStack image name (mutually exclusive with imageId)"),
        imageId: z.string().optional().describe("OpenStack image UUID (mutually exclusive with imageName)"),
        networkName: z.string().describe("OpenStack network name"),
        secGroups: z.string().optional().describe("Comma-separated security group names (default: default)"),
        keypairName: z.string().optional().describe("OpenStack keypair name for SSH access"),
        sshUser: z.string().optional().describe("SSH username on provisioned nodes (default: ubuntu)"),
        rootDiskSizeGb: z.number().int().optional().describe("Root disk size in GB (default: 20)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;

        context.logger.info(`Creating OpenStack node template '${args.name}'...`);

        const template = await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/nodetemplates", {
          name: args.name,
          driver: "openstack",
          cloudCredentialId: args.credentialId,
          openstackConfig: {
            authUrl: args.authUrl,
            username: args.username,
            password: args.password,
            domainName: args.domainName ?? "Default",
            tenantName: args.tenantName,
            region: args.region ?? "",
            flavorName: args.flavorName,
            ...(args.imageId ? { imageId: args.imageId } : { imageName: args.imageName }),
            netName: args.networkName,
            secGroups: args.secGroups ?? "default",
            keypairName: args.keypairName ?? "",
            sshUser: args.sshUser ?? "ubuntu",
            sshPort: "22",
            volumeSize: String(args.rootDiskSizeGb ?? 20),
            volumeType: "",
            ipVersion: "4",
            insecure: "false",
          },
        }, insecure);

        context.logger.info(`Node template '${args.name}' created with ID: ${template.id}`);

        const handle = await context.writeResource("nodeTemplate", args.name, {
          id: template.id,
          name: template.name ?? args.name,
          flavorName: args.flavorName,
          image: args.imageId ?? args.imageName ?? "",
          networkName: args.networkName,
          credentialId: args.credentialId,
        });

        return { dataHandles: [handle] };
      },
    },

    provisionCluster: {
      description: "Provision an RKE cluster on OpenStack via Rancher with control-plane and worker node pools",
      arguments: z.object({
        name: z.string().describe("Cluster name"),
        nodeTemplateId: z.string().describe("Node template ID (from createNodeTemplate output)"),
        kubernetesVersion: z.string().optional().describe("Kubernetes version (e.g. v1.28.x-rancher1-1; default: Rancher's default)"),
        controlPlaneCount: z.number().int().min(1).optional().describe("Number of control plane + etcd nodes (default: 1)"),
        workerCount: z.number().int().min(1).optional().describe("Number of worker nodes (default: 2)"),
        waitSeconds: z.number().int().optional().describe("Max seconds to wait for cluster to become active (default: 900; 0 = don't wait)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;
        const {
          name, nodeTemplateId, kubernetesVersion,
          controlPlaneCount = 1, workerCount = 2, waitSeconds = 900,
        } = args;

        context.logger.info(`Provisioning RKE cluster '${name}' on OpenStack...`);

        // 1. Create the cluster
        const clusterBody = {
          name,
          rancherKubernetesEngineConfig: {
            network: { plugin: "canal" },
            services: {
              etcd: { snapshot: false, retention: "72h", creation: "12h" },
            },
          },
        };
        if (kubernetesVersion) {
          clusterBody.rancherKubernetesEngineConfig.kubernetesVersion = kubernetesVersion;
        }

        const cluster = await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/clusters", clusterBody, insecure);
        context.logger.info(`Cluster '${name}' created with ID: ${cluster.id}`);

        // 2. Create control-plane + etcd node pool
        await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/nodePools", {
          clusterId: cluster.id,
          name: `${name}-controlplane`,
          hostnamePrefix: `${name}-cp-`,
          nodeTemplateId,
          quantity: controlPlaneCount,
          controlPlane: true,
          etcd: true,
          worker: false,
          deleteNotReadyAfterSecs: 0,
        }, insecure);
        context.logger.info(`Control-plane node pool created (${controlPlaneCount} node(s)).`);

        // 3. Create worker node pool
        await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/nodePools", {
          clusterId: cluster.id,
          name: `${name}-worker`,
          hostnamePrefix: `${name}-wk-`,
          nodeTemplateId,
          quantity: workerCount,
          controlPlane: false,
          etcd: false,
          worker: true,
          deleteNotReadyAfterSecs: 0,
        }, insecure);
        context.logger.info(`Worker node pool created (${workerCount} node(s)).`);

        // 4. Optionally wait for active
        const totalNodes = controlPlaneCount + workerCount;
        const maxWaitMs = waitSeconds * 1000;

        if (maxWaitMs > 0) {
          const deadline = Date.now() + maxWaitMs;
          context.logger.info(`Waiting up to ${waitSeconds}s for cluster to become active...`);

          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 15_000));
            const state = await rancherRequest(rancherUrl, rancherToken, "GET", `/v3/clusters/${cluster.id}`, null, insecure);
            context.logger.info(`Cluster state: ${state.state}  (${state.transitioningMessage ?? ""})`);

            if (state.state === "active") {
              context.logger.info(`Cluster '${name}' is active!`);
              const handle = await context.writeResource("cluster", name, {
                id: cluster.id,
                name,
                state: "active",
                kubernetesVersion: state.rancherKubernetesEngineConfig?.kubernetesVersion ?? kubernetesVersion ?? "unknown",
                nodeCount: totalNodes,
              });
              return { dataHandles: [handle] };
            }

            if (state.state === "error") {
              throw new Error(`Cluster '${name}' entered error state: ${state.transitioningMessage ?? "unknown error"}`);
            }
          }

          context.logger.info(`Cluster '${name}' did not become active within ${waitSeconds}s. Saving current state.`);
        }

        const handle = await context.writeResource("cluster", name, {
          id: cluster.id,
          name,
          state: cluster.state ?? "provisioning",
          kubernetesVersion: kubernetesVersion ?? "unknown",
          nodeCount: totalNodes,
        });

        return { dataHandles: [handle] };
      },
    },

    provisionAll: {
      description: "End-to-end: create OpenStack credential + node template in Rancher, then provision an RKE cluster",
      arguments: z.object({
        clusterName: z.string().describe("RKE cluster name"),
        authUrl: z.string().describe("OpenStack Keystone auth URL"),
        username: z.string().describe("OpenStack username"),
        password: z.string().describe("OpenStack password"),
        tenantName: z.string().describe("OpenStack project/tenant name"),
        domainName: z.string().optional().describe("OpenStack domain name (default: Default)"),
        region: z.string().optional().describe("OpenStack region"),
        flavorName: z.string().describe("OpenStack flavor (e.g. d2-2, m1.medium)"),
        imageName: z.string().optional().describe("OpenStack image name (mutually exclusive with imageId)"),
        imageId: z.string().optional().describe("OpenStack image UUID (mutually exclusive with imageName)"),
        networkName: z.string().describe("OpenStack network name"),
        secGroups: z.string().optional().describe("Comma-separated security group names (default: default)"),
        keypairName: z.string().optional().describe("OpenStack keypair name for SSH access"),
        sshUser: z.string().optional().describe("SSH user on provisioned nodes (default: ubuntu)"),
        rootDiskSizeGb: z.number().int().optional().describe("Root disk size in GB (default: 20)"),
        controlPlaneCount: z.number().int().min(1).optional().describe("Number of control plane + etcd nodes (default: 1)"),
        workerCount: z.number().int().min(1).optional().describe("Number of worker nodes (default: 2)"),
        kubernetesVersion: z.string().optional().describe("Kubernetes version (default: Rancher default)"),
        waitSeconds: z.number().int().optional().describe("Max seconds to wait for cluster active (default: 900)"),
        tailscaleAuthKey: z.string().optional().describe("Tailscale auth key — when provided, nodes will auto-join the tailnet via cloud-init"),
        tailscaleOperatorClientId: z.string().optional().describe("Tailscale OAuth client ID — when provided, tailscale-operator is installed on the cluster"),
        tailscaleOperatorClientSecret: z.string().optional().describe("Tailscale OAuth client secret — required when tailscaleOperatorClientId is set"),
        deleteAfterHours: z.number().optional().describe("Schedule cluster auto-deletion after this many hours (default: 12, set to 0 to disable)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;
        const {
          clusterName, authUrl, username, password, tenantName,
          flavorName, networkName,
          controlPlaneCount = 1, workerCount = 2, waitSeconds = 900,
        } = args;
        const domainName = args.domainName ?? "Default";
        const region = args.region ?? "";
        const namespace = "fleet-default";
        const machineConfigName = `${clusterName}-openstack`;

        // 1. Ensure the OpenStack node driver is active
        context.logger.info("Checking OpenStack node driver status...");
        const driverResp = await rancherRequest(rancherUrl, rancherToken, "GET",
          "/v3/nodedrivers/openstack", null, insecure).catch(() => null);
        if (driverResp && driverResp.state !== "active") {
          context.logger.info(`OpenStack driver state is '${driverResp.state}' — activating...`);
          await rancherRequest(rancherUrl, rancherToken, "POST",
            "/v3/nodedrivers/openstack?action=activate", {}, insecure);
          const driverDeadline = Date.now() + 120_000;
          while (Date.now() < driverDeadline) {
            await new Promise((r) => setTimeout(r, 3_000));
            const d = await rancherRequest(rancherUrl, rancherToken, "GET",
              "/v3/nodedrivers/openstack", null, insecure).catch(() => null);
            context.logger.info(`OpenStack driver state: ${d?.state ?? "unknown"}`);
            if (d?.state === "active") break;
          }
          context.logger.info("OpenStack driver is active.");
        } else {
          context.logger.info("OpenStack driver is already active.");
        }

        // 2. Create cloud credential (v3 API — stores password as a k8s secret)
        context.logger.info("Creating OpenStack cloud credential in Rancher...");
        const cred = await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/cloudcredentials", {
          name: `${clusterName}-cred`,
          openstackcredentialConfig: { password },
        }, insecure);
        context.logger.info(`Credential created: ${cred.id}`);
        // The v3 credential ID is already in "namespace:name" format (e.g. "cattle-global-data:cc-xxxxx")
        const credSecretName = cred.id;

        const credHandle = await context.writeResource("credential", "cred", {
          id: cred.id,
          name: cred.name ?? clusterName,
          createdAt: cred.created ?? new Date().toISOString(),
        });

        // 3. Determine Kubernetes version — required by Rancher's admission webhook
        let kubernetesVersion = args.kubernetesVersion ?? "";
        if (!kubernetesVersion) {
          context.logger.info("No kubernetesVersion specified — fetching Rancher default...");
          const setting = await rancherRequest(rancherUrl, rancherToken, "GET",
            "/v3/settings/rke2-default-version", null, insecure).catch(() => ({}));
          kubernetesVersion = setting.value ?? "";
          context.logger.info(`Using default k8s version: ${kubernetesVersion}`);
        }
        // Ensure the version has the "v" prefix (Rancher webhook requires it)
        if (kubernetesVersion && !kubernetesVersion.startsWith("v")) {
          kubernetesVersion = `v${kubernetesVersion}`;
        }
        if (!kubernetesVersion) {
          throw new Error("Could not determine a kubernetesVersion — please specify one explicitly");
        }

        // 4. Delete existing cluster first and wait for it to be fully gone.
        // This must happen before deleting the machine config, because the cluster holds
        // a reference to it — the machine config deletion won't complete while the cluster exists.
        context.logger.info(`Checking for existing cluster '${clusterName}'...`);
        await rancherRequest(rancherUrl, rancherToken, "DELETE",
          `/v1/provisioning.cattle.io.clusters/${namespace}/${clusterName}`,
          null, insecure).catch(() => {});
        const clusterDeleteDeadline = Date.now() + 300_000; // up to 5 min
        while (Date.now() < clusterDeleteDeadline) {
          const check = await rancherRequest(rancherUrl, rancherToken, "GET",
            `/v1/provisioning.cattle.io.clusters/${namespace}/${clusterName}`,
            null, insecure).catch((err) => {
              if (err.message?.includes("404") || err.message?.includes("NotFound")) return null;
              return undefined;
            });
          if (check === null) break; // 404 = fully deleted
          context.logger.info("Waiting for previous cluster deletion to complete...");
          await new Promise((r) => setTimeout(r, 10_000));
        }

        // 5. Now delete the machine config and wait for it to be fully gone.
        context.logger.info("Deleting existing machine config (if any)...");
        await rancherRequest(rancherUrl, rancherToken, "DELETE",
          `/v1/rke-machine-config.cattle.io.openstackconfigs/${namespace}/${machineConfigName}`,
          null, insecure).catch(() => {});
        const machineConfigDeleteDeadline = Date.now() + 120_000; // up to 2 min
        while (Date.now() < machineConfigDeleteDeadline) {
          const check = await rancherRequest(rancherUrl, rancherToken, "GET",
            `/v1/rke-machine-config.cattle.io.openstackconfigs/${namespace}/${machineConfigName}`,
            null, insecure).catch((err) => {
              if (err.message?.includes("404") || err.message?.includes("NotFound")) return null;
              return undefined;
            });
          if (check === null) break; // 404 = fully deleted
          context.logger.info("Waiting for previous machine config deletion to complete...");
          await new Promise((r) => setTimeout(r, 5_000));
        }

        // 6. Create new machine config
        context.logger.info("Creating OpenStack machine config in Rancher...");
        // Build cloud-init user data (stored in userDataFile field of OpenstackConfig)
        // Escape password for embedding in YAML (handle single quotes)
        const escapedPassword = password.replace(/'/g, "''");
        const userDataLines = [
          `#!/bin/bash`,
          `mkdir -p /var/lib/rancher/rke2/server/manifests`,
          `# Canal CNI config: use tailscale0 as flannel iface, MTU 1400 (must be present before RKE2 starts)`,
          `cat > /var/lib/rancher/rke2/server/manifests/rke2-canal-config.yaml << 'HELMEOF'`,
          `apiVersion: helm.cattle.io/v1`,
          `kind: HelmChartConfig`,
          `metadata:`,
          `  name: rke2-canal`,
          `  namespace: kube-system`,
          `spec:`,
          `  valuesContent: |-`,
          `    flannel:`,
          `      iface: tailscale0`,
          `      mtu: 1400`,
          `    calico:`,
          `      vethuMTU: 1400`,
          `HELMEOF`,
          `# OpenStack cloud-config Secret + CCM HelmChart`,
          `cat > /var/lib/rancher/rke2/server/manifests/openstack-ccm.yaml << 'CCMEOF'`,
          `apiVersion: v1`,
          `kind: Secret`,
          `metadata:`,
          `  name: cloud-config`,
          `  namespace: kube-system`,
          `stringData:`,
          `  cloud.conf: |`,
          `    [Global]`,
          `    auth-url=${authUrl}`,
          `    username=${username}`,
          `    password=${escapedPassword}`,
          `    tenant-name=${tenantName}`,
          `    domain-name=${domainName}`,
          `    region=${region}`,
          `    [LoadBalancer]`,
          `    use-octavia=true`,
          `    [BlockStorage]`,
          `    bs-version=v3`,
          `---`,
          `apiVersion: helm.cattle.io/v1`,
          `kind: HelmChart`,
          `metadata:`,
          `  name: openstack-cloud-controller-manager`,
          `  namespace: kube-system`,
          `spec:`,
          `  repo: https://kubernetes.github.io/cloud-provider-openstack`,
          `  chart: openstack-cloud-controller-manager`,
          `  targetNamespace: kube-system`,
          `  valuesContent: |-`,
          `    cloudConfig:`,
          `      secretName: cloud-config`,
          `    tolerations:`,
          `      - key: node.cloudprovider.kubernetes.io/uninitialized`,
          `        value: "true"`,
          `        effect: NoSchedule`,
          `      - key: node-role.kubernetes.io/control-plane`,
          `        effect: NoSchedule`,
          `      - key: node.kubernetes.io/not-ready`,
          `        effect: NoSchedule`,
          `CCMEOF`,
        ];
        if (args.tailscaleAuthKey) {
          userDataLines.push(
            `curl -fsSL https://tailscale.com/install.sh | sh`,
            `tailscale up --auth-key=${args.tailscaleAuthKey} --accept-routes --accept-dns`,
            `# Wait up to 120s for Tailscale to assign an IP, then write RKE2 tls-san drop-in`,
            `ELAPSED=0`,
            `TS_IP=$(tailscale ip -4 2>/dev/null)`,
            `while [ -z "$TS_IP" ] && [ $ELAPSED -lt 120 ]; do`,
            `  sleep 2; ELAPSED=$((ELAPSED + 2))`,
            `  TS_IP=$(tailscale ip -4 2>/dev/null)`,
            `done`,
            `if [ -n "$TS_IP" ]; then`,
            `  mkdir -p /etc/rancher/rke2/config.yaml.d`,
            `  printf 'tls-san:\\n  - %s\\n' "$TS_IP" > /etc/rancher/rke2/config.yaml.d/10-tailscale.yaml`,
            `fi`,
          );
        }
        const userDataFile = userDataLines.join("\n") + "\n";
        context.logger.info("Cloud-init: Canal CNI (flannel iface=tailscale0, MTU=1400) + OpenStack CCM" + (args.tailscaleAuthKey ? " + Tailscale + tls-san" : ""));

        const machineConfig = await rancherRequest(rancherUrl, rancherToken, "POST",
          "/v1/rke-machine-config.cattle.io.openstackconfigs", {
            apiVersion: "rke-machine-config.cattle.io/v1",
            kind: "OpenstackConfig",
            metadata: { name: machineConfigName, namespace },
            authUrl, username, password, domainName, tenantName, region,
            flavorName,
            ...(args.imageId ? { imageId: args.imageId } : { imageName: args.imageName ?? "" }),
            netName: networkName,
            secGroups: args.secGroups ?? "default",
            keypairName: args.keypairName ?? "",
            sshUser: args.sshUser ?? "ubuntu",
            sshPort: "22",
            volumeSize: String(args.rootDiskSizeGb ?? 20),
            volumeType: "high-speed",
            bootFromVolume: true,
            activeTimeout: "600",
            userDataFile,
          }, insecure);
        const machineConfigId = machineConfig.metadata?.name ?? machineConfigName;
        context.logger.info(`Machine config created: ${machineConfigId}`);

        const templateHandle = await context.writeResource("nodeTemplate", "config", {
          id: machineConfigId,
          name: machineConfigId,
          flavorName,
          image: args.imageId ?? args.imageName ?? "",
          networkName,
          credentialId: cred.id,
        });
        context.logger.info(`Provisioning RKE2 cluster '${clusterName}' (k8s: ${kubernetesVersion})...`);
        const clusterSpec = {
          kubernetesVersion,
          cloudCredentialSecretName: credSecretName,
          machineGlobalConfig: {
            cni: "canal",
          },
          rkeConfig: {
            chartValues: {
              "rke2-canal": {
                flannel: { iface: "tailscale0", mtu: 1400 },
                calico: { vethuMTU: 1400 },
              },
            },
            machinePools: [
              {
                name: "controlplane",
                quantity: controlPlaneCount,
                controlPlaneRole: true, etcdRole: true, workerRole: false,
                machineConfigRef: { kind: "OpenstackConfig", name: machineConfigId },
              },
              {
                name: "worker",
                quantity: workerCount,
                controlPlaneRole: false, etcdRole: false, workerRole: true,
                machineConfigRef: { kind: "OpenstackConfig", name: machineConfigId },
              },
            ],
          },
        };

        const cluster = await rancherRequest(rancherUrl, rancherToken, "POST",
          "/v1/provisioning.cattle.io.clusters", {
            apiVersion: "provisioning.cattle.io/v1",
            kind: "Cluster",
            metadata: { name: clusterName, namespace },
            spec: clusterSpec,
          }, insecure);
        context.logger.info(`Cluster '${clusterName}' created.`);

        // 4. Wait for cluster to become ready
        const totalNodes = controlPlaneCount + workerCount;
        const maxWaitMs = waitSeconds * 1000;

        if (maxWaitMs > 0) {
          const deadline = Date.now() + maxWaitMs;
          context.logger.info(`Waiting up to ${waitSeconds}s for cluster to become ready...`);
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 15_000));
            let s;
            try {
              s = await rancherRequest(rancherUrl, rancherToken, "GET",
                `/v1/provisioning.cattle.io.clusters/${namespace}/${clusterName}`, null, insecure);
            } catch (err) {
              context.logger.info(`Cluster GET error: ${err.message} — retrying...`);
              continue;
            }
            const conditions = s.status?.conditions ?? [];
            const readyCond = conditions.find((c) => c.type === "Ready");
            const ready = s.status?.ready === true || readyCond?.status === "True";
            const summaryMsg = s.status?.summary?.message ?? readyCond?.message ?? "";
            const summaryError = s.status?.summary?.error === true;
            const stateMsg = s.metadata?.state?.message ?? s.metadata?.state?.name ?? "";
            context.logger.info(`Cluster state: ${s.metadata?.state?.name ?? "unknown"}  ${summaryMsg || stateMsg}`);
            if (ready) {
              context.logger.info(`Cluster '${clusterName}' is ready!`);
              // Fetch SSH keys for troubleshooting
              await fetchAndSaveSshKeys(rancherUrl, rancherToken, clusterName, insecure ?? false, context.logger);
              const mgmtId = s.status?.clusterName ?? clusterName;
              const k8sVer = s.spec?.kubernetesVersion ?? kubernetesVersion ?? "unknown";
              // Install Tailscale operator if credentials were provided
              if (args.tailscaleOperatorClientId && args.tailscaleOperatorClientSecret) {
                await installTailscaleOperator(
                  rancherUrl, rancherToken, mgmtId,
                  args.tailscaleOperatorClientId, args.tailscaleOperatorClientSecret,
                  insecure ?? false, context.logger,
                );
              }
              // Schedule auto-deletion (default 12h, disabled if deleteAfterHours === 0)
              const deleteAfterHours = args.deleteAfterHours ?? 12;
              if (deleteAfterHours > 0) {
                context.logger.info(`Scheduling auto-deletion of '${clusterName}' in ${deleteAfterHours}h...`);
                await scheduleClusterDelete(rancherUrl, rancherToken, clusterName, deleteAfterHours, insecure ?? false, context.logger);
              }
              const h = await context.writeResource("cluster", "cluster", {
                id: mgmtId, name: clusterName, state: "active", kubernetesVersion: k8sVer, nodeCount: totalNodes,
              });
              return { dataHandles: [credHandle, templateHandle, h] };
            }
            // Fail fast if the cluster is in error state (e.g. quota exceeded, invalid config)
            if (summaryError || s.metadata?.state?.error === true) {
              throw new Error(`Cluster '${clusterName}' entered error state: ${summaryMsg || stateMsg || "unknown error"}`);
            }
          }
          context.logger.info(`Cluster did not become ready within ${waitSeconds}s. Saving current state.`);
        }

        // Fetch SSH keys even if cluster didn't become ready (machines may exist)
        await fetchAndSaveSshKeys(rancherUrl, rancherToken, clusterName, insecure ?? false, context.logger);

        const h = await context.writeResource("cluster", clusterName, {
          id: cluster.metadata?.name ?? clusterName,
          name: clusterName, state: "provisioning",
          kubernetesVersion: kubernetesVersion ?? "unknown",
          nodeCount: totalNodes,
        });
        return { dataHandles: [credHandle, templateHandle, h] };
      },
    },

    getKubeconfig: {
      description: "Generate and print the kubeconfig for a provisioned cluster",
      arguments: z.object({
        clusterId: z.string().describe("Management cluster ID (c-m-xxxxx from cluster resource)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;

        context.logger.info(`Generating kubeconfig for cluster '${args.clusterId}'...`);

        const data = await rancherRequest(
          rancherUrl, rancherToken, "POST",
          `/v3/clusters/${args.clusterId}?action=generateKubeconfig`,
          {}, insecure,
        );

        context.logger.info("--- kubeconfig start ---");
        context.logger.info(data.config);
        context.logger.info("--- kubeconfig end ---");

        return { dataHandles: [] };
      },
    },

    scheduleDelete: {
      description: "Deploy a CronJob in the Rancher local cluster that deletes a provisioned cluster after a TTL",
      arguments: z.object({
        clusterName: z.string().describe("Cluster name to delete"),
        delayHours: z.number().optional().describe("Hours before deletion (default: 12)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;
        const delayHours = args.delayHours ?? 12;
        await scheduleClusterDelete(rancherUrl, rancherToken, args.clusterName, delayHours, insecure ?? false, context.logger);
        return { dataHandles: [] };
      },
    },

    deleteCluster: {
      description: "Delete an OpenStack cluster from Rancher",
      arguments: z.object({
        clusterName: z.string().describe("Cluster name to delete"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken, insecure } = context.globalArgs;
        const namespace = "fleet-default";

        context.logger.info(`Deleting cluster '${args.clusterName}'...`);
        await rancherRequest(rancherUrl, rancherToken, "DELETE",
          `/v1/provisioning.cattle.io.clusters/${namespace}/${args.clusterName}`, null, insecure).catch(() => {});
        context.logger.info(`Cluster '${args.clusterName}' deletion initiated. Waiting for it to be fully removed...`);

        const deadline = Date.now() + 300_000; // up to 5 min
        while (Date.now() < deadline) {
          const check = await rancherRequest(rancherUrl, rancherToken, "GET",
            `/v1/provisioning.cattle.io.clusters/${namespace}/${args.clusterName}`,
            null, insecure).catch((err) => {
              if (err.message?.includes("404") || err.message?.includes("NotFound")) return null;
              return undefined;
            });
          if (check === null) {
            context.logger.info(`Cluster '${args.clusterName}' fully deleted.`);
            break;
          }
          context.logger.info("Waiting for cluster deletion to complete...");
          await new Promise((r) => setTimeout(r, 10_000));
        }

        return { dataHandles: [] };
      },
    },

    fetchSshKeys: {
      description: "Fetch SSH private keys for all machines in a cluster from Rancher's machine-state secrets",
      arguments: z.object({
        clusterName: z.string().describe("Cluster name to fetch SSH keys for"),
      }),
      execute: async (args, context) => {
        try {
          const { rancherUrl, rancherToken, insecure } = context.globalArgs;
          context.logger.info(`fetchSshKeys starting for cluster '${args.clusterName}'`);
          context.logger.info(`rancherUrl: ${rancherUrl}, hasToken: ${!!rancherToken}, insecure: ${insecure}`);

          const savedKeys = await fetchAndSaveSshKeys(
            rancherUrl, rancherToken, args.clusterName, insecure ?? false, context.logger,
          );

          if (savedKeys.length === 0) {
            context.logger.info("No SSH keys were found. Machines may not be provisioned yet.");
          } else {
            context.logger.info(`Saved ${savedKeys.length} SSH key(s) to ${SSH_KEY_DIR}/:`);
            for (const k of savedKeys) {
              context.logger.info(`  ${k.nodeName} → ${k.keyPath}`);
            }
            context.logger.info(`SSH example: ssh -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i "${savedKeys[0].keyPath}" ubuntu@<node-ip>`);
          }

          return { dataHandles: [] };
        } catch (err) {
          context.logger.info(`fetchSshKeys FAILED: ${err.message}\n${err.stack}`);
          // Also write to a debug file
          await Deno.writeTextFile("/tmp/swamp-fetchsshkeys-error.txt", `${new Date().toISOString()}\n${err.message}\n${err.stack}\n`);
          return { dataHandles: [] };
        }
      },
    },
  },
};
