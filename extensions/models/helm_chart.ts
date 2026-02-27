import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  kubeconfig: z.string().describe("kubeconfig YAML content for the target cluster"),
});

const ReleaseSchema = z.object({
  releaseName: z.string(),
  namespace: z.string(),
  chart: z.string(),
  version: z.string(),
  status: z.string(),
  notes: z.string(),
});

const dec = new TextDecoder();

async function runHelm(kubeconfigFile, args, { allowFailure = false } = {}) {
  const proc = new Deno.Command("helm", {
    args,
    env: { KUBECONFIG: kubeconfigFile },
    stdout: "piped",
    stderr: "piped",
  });

  const result = await proc.output();
  const stdout = dec.decode(result.stdout).trim();
  const stderr = dec.decode(result.stderr).trim();

  if (!allowFailure && result.code !== 0) {
    throw new Error(`helm failed (exit ${result.code}):\n$ helm ${args.join(" ")}\nstderr: ${stderr}`);
  }
  return { stdout, stderr, code: result.code };
}

async function withKubeconfig(kubeconfig, fn) {
  const kubeconfigFile = `/tmp/.swamp-helm-kubeconfig-${Date.now()}`;
  await Deno.writeTextFile(kubeconfigFile, kubeconfig.endsWith("\n") ? kubeconfig : kubeconfig + "\n", { mode: 0o600 });
  try {
    return await fn(kubeconfigFile);
  } finally {
    await Deno.remove(kubeconfigFile).catch(() => {});
  }
}

export const model = {
  type: "@rjeschmi/helm-chart",
  version: "2026.02.27.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    release: {
      description: "A Helm release installed in the cluster",
      schema: ReleaseSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    install: {
      description: "Install or upgrade a Helm chart (helm upgrade --install)",
      arguments: z.object({
        releaseName: z.string().describe("Helm release name"),
        chart: z.string().describe("Chart name (e.g. ingress-nginx/ingress-nginx) or local path"),
        namespace: z.string().describe("Kubernetes namespace to install into"),
        repoName: z.string().optional().describe("Helm repo name to add (e.g. ingress-nginx)"),
        repoUrl: z.string().optional().describe("Helm repo URL (required if repoName is set)"),
        version: z.string().optional().describe("Chart version (default: latest)"),
        values: z.record(z.string(), z.unknown()).optional().describe("Values to set (equivalent to --set key=value)"),
        valuesYaml: z.string().optional().describe("Raw values YAML string (equivalent to -f values.yaml)"),
        createNamespace: z.boolean().optional().describe("Create the namespace if it does not exist (default: true)"),
        reuseValues: z.boolean().optional().describe("Reuse previously installed values on upgrade, only overriding what is explicitly set (default: false)"),
        waitSeconds: z.number().int().optional().describe("Seconds to wait for resources to be ready (default: 300, 0 to skip)"),
      }),
      execute: async (args, context) => {
        const { kubeconfig } = context.globalArgs;
        const {
          releaseName, chart, namespace,
          repoName, repoUrl,
          version, values, valuesYaml,
          createNamespace = true,
          reuseValues = false,
          waitSeconds = 300,
        } = args;

        return await withKubeconfig(kubeconfig, async (kubeconfigFile) => {
          // Add helm repo if specified
          if (repoName && repoUrl) {
            context.logger.info(`Adding Helm repo ${repoName} → ${repoUrl}...`);
            await runHelm(kubeconfigFile, ["repo", "add", repoName, repoUrl, "--force-update"]);
            context.logger.info("Updating Helm repos...");
            await runHelm(kubeconfigFile, ["repo", "update"]);
          }

          // Build helm upgrade --install args
          const helmArgs = ["upgrade", "--install", releaseName, chart, "--namespace", namespace];

          if (createNamespace) helmArgs.push("--create-namespace");
          if (reuseValues) helmArgs.push("--reuse-values");
          if (version) helmArgs.push("--version", version);

          if (values) {
            for (const [key, val] of Object.entries(values)) {
              helmArgs.push("--set", `${key}=${val}`);
            }
          }

          if (valuesYaml) {
            const valuesFile = `/tmp/.swamp-helm-values-${Date.now()}.yaml`;
            await Deno.writeTextFile(valuesFile, valuesYaml);
            helmArgs.push("-f", valuesFile);
            // Clean up values file after helm runs (inside withKubeconfig scope)
            try {
              if (waitSeconds > 0) {
                helmArgs.push("--wait", "--timeout", `${waitSeconds}s`);
              }
              context.logger.info(`Running: helm ${helmArgs.join(" ")}`);
              await runHelm(kubeconfigFile, helmArgs);
            } finally {
              await Deno.remove(valuesFile).catch(() => {});
            }
          } else {
            if (waitSeconds > 0) {
              helmArgs.push("--wait", "--timeout", `${waitSeconds}s`);
            }
            context.logger.info(`Running: helm ${helmArgs.join(" ")}`);
            await runHelm(kubeconfigFile, helmArgs);
          }

          // Get release status
          context.logger.info("Fetching release status...");
          const statusRes = await runHelm(kubeconfigFile, [
            "status", releaseName, "--namespace", namespace, "--output", "json",
          ]);
          let status = "deployed";
          let notes = "";
          let installedVersion = version ?? "";
          try {
            const statusJson = JSON.parse(statusRes.stdout);
            status = statusJson.info?.status ?? "deployed";
            notes = statusJson.info?.notes ?? "";
            installedVersion = statusJson.chart?.metadata?.version ?? version ?? "";
          } catch {
            // ignore parse errors — status output may vary
          }

          context.logger.info(`Release '${releaseName}' in namespace '${namespace}': ${status}`);

          const handle = await context.writeResource("release", releaseName, {
            releaseName,
            namespace,
            chart,
            version: installedVersion,
            status,
            notes,
          });

          return { dataHandles: [handle] };
        });
      },
    },

    uninstall: {
      description: "Uninstall a Helm release",
      arguments: z.object({
        releaseName: z.string().describe("Helm release name to uninstall"),
        namespace: z.string().describe("Kubernetes namespace of the release"),
      }),
      execute: async (args, context) => {
        const { kubeconfig } = context.globalArgs;
        const { releaseName, namespace } = args;

        return await withKubeconfig(kubeconfig, async (kubeconfigFile) => {
          context.logger.info(`Uninstalling release '${releaseName}' from namespace '${namespace}'...`);
          await runHelm(kubeconfigFile, ["uninstall", releaseName, "--namespace", namespace], { allowFailure: true });
          context.logger.info(`Release '${releaseName}' uninstalled.`);
          return { dataHandles: [] };
        });
      },
    },

    status: {
      description: "Get the status of an installed Helm release",
      arguments: z.object({
        releaseName: z.string().describe("Helm release name"),
        namespace: z.string().describe("Kubernetes namespace of the release"),
      }),
      execute: async (args, context) => {
        const { kubeconfig } = context.globalArgs;
        const { releaseName, namespace } = args;

        return await withKubeconfig(kubeconfig, async (kubeconfigFile) => {
          context.logger.info(`Getting status for '${releaseName}' in namespace '${namespace}'...`);
          const statusRes = await runHelm(kubeconfigFile, [
            "status", releaseName, "--namespace", namespace, "--output", "json",
          ]);

          let status = "unknown";
          let notes = "";
          let chart = "";
          let installedVersion = "";
          try {
            const statusJson = JSON.parse(statusRes.stdout);
            status = statusJson.info?.status ?? "unknown";
            notes = statusJson.info?.notes ?? "";
            chart = statusJson.chart?.metadata?.name ?? "";
            installedVersion = statusJson.chart?.metadata?.version ?? "";
          } catch {
            // ignore
          }

          context.logger.info(`Status: ${status}`);

          const handle = await context.writeResource("release", releaseName, {
            releaseName,
            namespace,
            chart,
            version: installedVersion,
            status,
            notes,
          });

          return { dataHandles: [handle] };
        });
      },
    },
  },
};
