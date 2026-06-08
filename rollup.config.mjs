import { nodeResolve } from "@rollup/plugin-node-resolve";

// ComfyUI serves this extension at /extensions/comfyui-splat-loader/ and its own
// scripts at /scripts/. Leave those imports as live browser imports, bundle the rest.
const external = (id) => id.startsWith("../../scripts/");

export default {
  input: "src/viewport.js",
  external,
  output: {
    file: "web/viewport.js",
    format: "es",
    sourcemap: true,
  },
  plugins: [nodeResolve()],
};
