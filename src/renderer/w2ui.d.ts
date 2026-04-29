// w2ui v2 ships ESM but no .d.ts. Declare the surface we use as `any` so
// TypeScript leaves us alone; the runtime types are documented at https://w2ui.com.
declare module 'w2ui/w2ui-2.0.es6.min.js' {
  export const w2grid: any;
  export const w2layout: any;
  export const w2sidebar: any;
  export const w2form: any;
  export const w2toolbar: any;
  export const w2utils: any;
  export const w2popup: any;
  export const w2tabs: any;
}
