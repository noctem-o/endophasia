// Binds the plugin definition to the installed OpenClaw SDK and TypeBox. Built to dist/index.js by build.mjs.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createEndophasiaStatusPluginV0, type DefineToolPluginV0, type TypeBuilderV0 } from "./plugin.ts";

export default createEndophasiaStatusPluginV0({
	defineToolPlugin: defineToolPlugin as unknown as DefineToolPluginV0,
	Type: Type as unknown as TypeBuilderV0,
});
