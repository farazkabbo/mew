import { installBackground } from "./runtime.js";
import { BUILD_TARGET } from "./target.js";
installBackground(globalThis.browser ?? globalThis.chrome, { target: BUILD_TARGET });
