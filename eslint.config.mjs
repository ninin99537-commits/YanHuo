import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginBetterTailwindcss from 'eslint-plugin-better-tailwindcss';
import importx from 'eslint-plugin-import-x';
import pinia from 'eslint-plugin-pinia';
import vue from 'eslint-plugin-vue';
import { globalIgnores } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigFile} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  importx.flatConfigs.recommended,
  importx.flatConfigs.typescript,
  ...vue.configs['flat/recommended'],
  pinia.configs['recommended-flat'],
  {
    files: ['src/**/*.{html,vue,js,ts}'],
    plugins: {
      'better-tailwindcss': eslintPluginBetterTailwindcss,
    },
    rules: {
      ...eslintPluginBetterTailwindcss.configs['recommended-warn'].rules,
      ...eslintPluginBetterTailwindcss.configs['recommended-error'].rules,
      'better-tailwindcss/enforce-consistent-line-wrapping': ['off', { preferSingleLine: true, printWidth: 120 }],
      'better-tailwindcss/no-unregistered-classes': ['off', { ignore: ['fa-*'] }],
      // 本仓库**不使用** Tailwind 工具类 —— tailwind.css:1 明写「仅激活 tailwindcss 的语法高亮, 禁止实际使用这个文件」。
      // 界面类名全是自定义的(bf-*/yh-*/ep-*/sf-* …), 样式写在各组件自己的 <style scoped> 里,
      // 而这条规则按"类名必须是 tailwindcss 里注册过的"来判, 于是整片报成未知 ——
      // 实测 1640 条(占全仓库 lint 问题的 90%), 把同一轮里 74 条真错误彻底淹没(等于没有闸门)。
      // 将来若真的开始用 Tailwind 工具类, 再打开它, 并用 ignore(正则数组)排除自定义前缀。
      'better-tailwindcss/no-unknown-classes': 'off',
    },
    settings: {
      'better-tailwindcss': {
        entryPoint: 'tailwind.css',
        tailwindConfig: 'tailwind.config.js',
      },
    },
  },
  {
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        // 必须显式指定: 不指定时解析器会自己去搜 tsconfig.json, 一旦仓库里出现第二份
        // (例如 .kilo/worktrees/ 下的项目副本), 它就报 "multiple candidate TSConfigRootDirs"
        // 并让**每个文件**都解析失败——541 条这种错会把真正的 74 条错误全遮住。
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'handle-callback-err': 'off',
      'import-x/no-console': 'off',
      'import-x/no-cycle': 'error',
      'import-x/no-dynamic-require': 'warn',
      'import-x/no-nodejs-modules': 'warn',
      'import-x/no-unresolved': [2, { ignore: ['^http'] }],
      'no-dupe-class-members': 'off',
      'no-empty-function': 'off',
      'no-floating-decimal': 'error',
      'no-lonely-if': 'error',
      'no-multi-spaces': 'error',
      'no-redeclare': 'off',
      'no-shadow': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-var': 'error',
      'pinia/no-duplicate-store-ids': 'off',
      'pinia/require-setup-store-properties-export': 'off',
      'prefer-const': 'warn',
      'vue/multi-word-component-names': 'off',
      yoda: 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  eslintConfigPrettier,
  // tests/ 是用例代码(大量 any 的临时假实现), 不属于发布产物; tsconfig 的 include 也没收录它,
  // 所以这里同样排除, 免得用例给 lint 添乱。
  // .kilo/ 是别的工具的工作区(含 node_modules 与一份项目副本), _backup/ 是历史备份快照:
  // 两者都不是本仓库的源码, 一起 lint 只会把真错误淹没, 还会拖慢每一次检查。
  // tavern_sync.mjs 是 2.1MB 的 webpack 打包产物(63026 行, 已提交进仓库), 里面 1086 条
  // no-var 之类的全是生成代码的噪声 —— 生成物一律不 lint, 与 dist/ 同理。
  globalIgnores(['dist/**', 'node_modules/**', 'tests/**', '.kilo/**', '_backup/**', 'tavern_sync.mjs', 'eslint.config.mjs', 'postcss.config.js', 'webpack.config.ts']),
];
