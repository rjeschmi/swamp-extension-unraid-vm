import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  rancherUrl: z.string().describe("Rancher server URL (e.g. https://rancher.example.com)"),
  rancherToken: z.string().describe("Rancher API bearer token (e.g. token-xxxxx:yyyyyyyyy)"),
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
  imageName: z.string(),
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

const dec = new TextDecoder();

async function rancherRequest(rancherUrl, token, method, path, body) {
  const url = `${rancherUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Rancher API ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (!text) return {};
  return JSON.parse(text);
}

export const model = {
  type: "@rjeschmi/rancher-openstack",
  version: "2026.02.22.1",
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
        const { rancherUrl, rancherToken } = context.globalArgs;
        const { name, authUrl, username, password, domainName, tenantName, region } = args;

        context.logger.info(`Creating OpenStack cloud credential '${name}' in Rancher...`);

        const cred = await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/cloudcredentials", {
          name,
          openstackCredentialConfig: {
            username,
            password,
            authUrl,
            domainName: domainName ?? "Default",
            tenantName,
            ...(region ? { region } : {}),
          },
        });

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
        imageName: z.string().describe("OpenStack image name (e.g. Ubuntu-22.04-cloud)"),
        networkName: z.string().describe("OpenStack network name"),
        secGroups: z.string().optional().describe("Comma-separated security group names (default: default)"),
        keypairName: z.string().optional().describe("OpenStack keypair name for SSH access"),
        sshUser: z.string().optional().describe("SSH username on provisioned nodes (default: ubuntu)"),
        rootDiskSizeGb: z.number().int().optional().describe("Root disk size in GB (default: 20)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken } = context.globalArgs;

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
            imageName: args.imageName,
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
        });

        context.logger.info(`Node template '${args.name}' created with ID: ${template.id}`);

        const handle = await context.writeResource("nodeTemplate", args.name, {
          id: template.id,
          name: template.name ?? args.name,
          flavorName: args.flavorName,
          imageName: args.imageName,
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
        const { rancherUrl, rancherToken } = context.globalArgs;
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

        const cluster = await rancherRequest(rancherUrl, rancherToken, "POST", "/v3/clusters", clusterBody);
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
        });
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
        });
        context.logger.info(`Worker node pool created (${workerCount} node(s)).`);

        // 4. Optionally wait for active
        const totalNodes = controlPlaneCount + workerCount;
        const maxWaitMs = waitSeconds * 1000;

        if (maxWaitMs > 0) {
          const deadline = Date.now() + maxWaitMs;
          context.logger.info(`Waiting up to ${waitSeconds}s for cluster to become active...`);

          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 15_000));
            const state = await rancherRequest(rancherUrl, rancherToken, "GET", `/v3/clusters/${cluster.id}`, null);
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

    getKubeconfig: {
      description: "Generate and print the kubeconfig for a provisioned cluster",
      arguments: z.object({
        clusterId: z.string().describe("Cluster ID (from provisionCluster output)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken } = context.globalArgs;

        context.logger.info(`Generating kubeconfig for cluster '${args.clusterId}'...`);

        const url = `${rancherUrl.replace(/\/$/, "")}/v3/clusters/${args.clusterId}?action=generateKubeconfig`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${rancherToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) {
          throw new Error(`Failed to generate kubeconfig (${res.status}): ${await res.text()}`);
        }

        const data = await res.json();
        context.logger.info("--- kubeconfig start ---");
        context.logger.info(data.config);
        context.logger.info("--- kubeconfig end ---");

        return { dataHandles: [] };
      },
    },

    deleteCluster: {
      description: "Delete an OpenStack cluster from Rancher",
      arguments: z.object({
        clusterId: z.string().describe("Cluster ID to delete"),
        clusterName: z.string().describe("Cluster name (for logging)"),
      }),
      execute: async (args, context) => {
        const { rancherUrl, rancherToken } = context.globalArgs;

        context.logger.info(`Deleting cluster '${args.clusterName}' (${args.clusterId})...`);
        await rancherRequest(rancherUrl, rancherToken, "DELETE", `/v3/clusters/${args.clusterId}`, null);
        context.logger.info(`Cluster '${args.clusterName}' deletion initiated.`);

        return { dataHandles: [] };
      },
    },
  },
};
