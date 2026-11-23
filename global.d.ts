declare module '*?raw' {
  const content: string;
  export default content;
}
declare module '*?url' {
  const content: string;
  export default content;
}
declare module '*.css' {
  const content: unknown;
  export default content;
}
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*.md' {
  const content: string;
  export default content;
}
declare module '*.yaml' {
  const content: any;
  export default content;
}
declare module '*.vue' {
  import { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}

declare const YAML: typeof import('yaml');

/** 构建时注入(webpack.config.ts 的 DefinePlugin): 打包那一刻的 commit 与本地时间 */
declare const __构建信息__: { commit: string; 构建时间: string };

declare const z: typeof import('zod');
declare namespace z {
  export type infer<T> = import('zod').infer<T>;
  export type input<T> = import('zod').input<T>;
  export type output<T> = import('zod').output<T>;
  /**
   * `z.ZodType` 这类**类型**在 `zod` 里是"值与类型同名"(class/interface 双声明):
   * `z.ZodType` 作为值取到的是构造函数, 但这里 `declare const z` 只声明了**值**那一侧,
   * 命名空间里没有对应的类型成员, 于是 `z.ZodType<...>` 当类型用会报 TS2749
   * ("refers to a value, but is being used as a type here")。
   *
   * 这里把真正被用到的几个类型补进命名空间 —— 只是把 `zod` 已有的类型再导出一次,
   * 不改任何运行时形状(`declare` 不产生代码)。
   */
  export type ZodType<Output = unknown, Input = unknown> = import('zod').ZodType<Output, Input>;
  export type ZodObject<
    Shape extends import('zod').core.$ZodLooseShape = import('zod').core.$ZodLooseShape,
  > = import('zod').ZodObject<Shape>;
  export type ZodError<T = unknown> = import('zod').ZodError<T>;
}

declare module 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js' {
  export function registerMvuSchema(
    schema: z.ZodType<Record<string, any>> | (() => z.ZodType<Record<string, any>>),
  ): void;
}
