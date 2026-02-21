import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  host: z.string().describe("Unraid server URL, e.g. https://tower.local"),
  apiKey: z.string().describe("Unraid API key from Settings > API Keys"),
});

const VmSchema = z.object({
  id: z.string(),
  uuid: z.string(),
  name: z.string(),
  state: z.string(),
});

const ResultSchema = z.object({
  vmUuid: z.string(),
  operation: z.string(),
  success: z.boolean(),
});

const ControlArgsSchema = z.object({
  vmUuid: z.string().describe("UUID of the VM to control"),
});

async function graphqlRequest(host, apiKey, query, variables = {}) {
  const url = host.replace(/\.$/, "") + "/graphql";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${await response.text()}`);
  }

  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join(", ")}`);
  }
  return body.data;
}

export const model = {
  type: "@user/unraid-vm",
  version: "2026.02.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description: "An Unraid virtual machine (factory — one per VM)",
      schema: VmSchema,
      lifetime: "infinite",
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
    list: {
      description: "List all virtual machines on the Unraid server",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const data = await graphqlRequest(
          context.globalArgs.host,
          context.globalArgs.apiKey,
          `query { vms { domain { id uuid name state } } }`,
        );

        const domains = data?.vms?.domain ?? [];
        context.logger.info(`Found ${domains.length} VM(s)`);

        const handles = [];
        for (const vm of domains) {
          const handle = await context.writeResource("vm", vm.uuid, {
            id: vm.id,
            uuid: vm.uuid,
            name: vm.name,
            state: vm.state,
          });
          handles.push(handle);
          context.logger.info(`  ${vm.name}  id=${vm.id}  uuid=${vm.uuid}  state=${vm.state}`);
        }
        return { dataHandles: handles };
      },
    },

    start: {
      description: "Start a virtual machine",
      arguments: ControlArgsSchema,
      execute: async (args, context) => {
        const data = await graphqlRequest(
          context.globalArgs.host,
          context.globalArgs.apiKey,
          `mutation StartVm($id: PrefixedID!) { vm { start(id: $id) } }`,
          { id: args.vmUuid },
        );
        const success = data.vm.start;
        context.logger.info(`Start VM ${args.vmUuid}: ${success ? "succeeded" : "failed"}`);
        const handle = await context.writeResource("result", "latest", { vmUuid: args.vmUuid, operation: "start", success });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Gracefully stop a VM via ACPI signal",
      arguments: ControlArgsSchema,
      execute: async (args, context) => {
        const data = await graphqlRequest(
          context.globalArgs.host,
          context.globalArgs.apiKey,
          `mutation StopVm($id: PrefixedID!) { vm { stop(id: $id) } }`,
          { id: args.vmUuid },
        );
        const success = data.vm.stop;
        context.logger.info(`Stop VM ${args.vmUuid}: ${success ? "succeeded" : "failed"}`);
        const handle = await context.writeResource("result", "latest", { vmUuid: args.vmUuid, operation: "stop", success });
        return { dataHandles: [handle] };
      },
    },

    forceStop: {
      description: "Force power off a VM immediately",
      arguments: ControlArgsSchema,
      execute: async (args, context) => {
        const data = await graphqlRequest(
          context.globalArgs.host,
          context.globalArgs.apiKey,
          `mutation ForceStopVm($id: PrefixedID!) { vm { forceStop(id: $id) } }`,
          { id: args.vmUuid },
        );
        const success = data.vm.forceStop;
        context.logger.info(`Force-stop VM ${args.vmUuid}: ${success ? "succeeded" : "failed"}`);
        const handle = await context.writeResource("result", "latest", { vmUuid: args.vmUuid, operation: "forceStop", success });
        return { dataHandles: [handle] };
      },
    },

    pause: {
      description: "Pause a running VM",
      arguments: ControlArgsSchema,
      execute: async (args, context) => {
        const data = await graphqlRequest(
          context.globalArgs.host,
          context.globalArgs.apiKey,
          `mutation PauseVm($id: PrefixedID!) { vm { pause(id: $id) } }`,
          { id: args.vmUuid },
        );
        const success = data.vm.pause;
        context.logger.info(`Pause VM ${args.vmUuid}: ${success ? "succeeded" : "failed"}`);
        const handle = await context.writeResource("result", "latest", { vmUuid: args.vmUuid, operation: "pause", success });
        return { dataHandles: [handle] };
      },
    },

    resume: {
      description: "Resume a paused VM",
      arguments: ControlArgsSchema,
      execute: async (args, context) => {
        const data = await graphqlRequest(
          context.globalArgs.host,
          context.globalArgs.apiKey,
          `mutation ResumeVm($id: PrefixedID!) { vm { resume(id: $id) } }`,
          { id: args.vmUuid },
        );
        const success = data.vm.resume;
        context.logger.info(`Resume VM ${args.vmUuid}: ${success ? "succeeded" : "failed"}`);
        const handle = await context.writeResource("result", "latest", { vmUuid: args.vmUuid, operation: "resume", success });
        return { dataHandles: [handle] };
      },
    },
  },
};
