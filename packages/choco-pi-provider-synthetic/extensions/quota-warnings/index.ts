import { createLazyExtension } from "../_shared/lazy-extension.ts";

export default createLazyExtension(() => import("./runtime.ts"));
