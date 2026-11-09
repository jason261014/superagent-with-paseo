/** Source types for generated ESM entries, also available before the first build. */
declare module '*server/provider.mjs' {
  export const createSuperagentProvider: typeof import('../src/paseo-ui/provider.ts').createSuperagentProvider
  export const createProjectProvider: typeof import('../src/paseo-ui/provider.ts').createProjectProvider
}
declare module '*server/project-manager.mjs' {
  export const createProjectManager: typeof import('../src/projects/manager.ts').createProjectManager
  export const resolvePluginOptions: typeof import('../src/projects/config.ts').resolvePluginOptions
}
declare module '*server/host-control.mjs' {
  export const createPluginHostControl: typeof import('../src/paseo-ui/host-control.ts').createPluginHostControl
  export type HostConfig = import('../src/hosts/paseo.ts').HostConfig
}
