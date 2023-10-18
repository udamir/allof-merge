import babel from '@rollup/plugin-babel';
import filesize from 'rollup-plugin-filesize';
import progress from 'rollup-plugin-progress';
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import pkg from './package.json';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

const inputPath = './src'

const banner = `/*!
 * allof-merge v${pkg.version}
 *
 * Copyright (C) 2012-${new Date().getFullYear()} ${pkg.author}.
 *
 * Date: ${new Date().toUTCString()}
 */
`;

const extensions = ['.ts', '.js'];

const jsPlugins = [
    resolve(),
    commonjs({
        include: 'node_modules/**',
    }),
    json(),
    progress(),
    filesize({
        showGzippedSize: true,
    }),
    typescript(),
    babel({
        babelHelpers: 'bundled',
        exclude: 'node_modules/**',
        include: [`${inputPath}/**/*`],
        extensions,
    }),
    terser()
];

export default [
    {
        input: `${inputPath}/index.ts`,
        output: {
            file: `${pkg.main}`,
            format: 'umd',
            banner,
            name: 'AllofMerge',
            sourcemap: true,
        },
        plugins: jsPlugins
    },
    {
        input: `${inputPath}/index.ts`,
        output: {
            file: `${pkg.module}`,
            banner,
            format: 'esm',
            name: 'AllofMerge',
            sourcemap: true,
        },
        plugins: jsPlugins
    },
    {
        input: `${inputPath}/index.ts`,
        output: {
            file: `${pkg.browser}`,
            banner,
            format: 'iife',
            name: 'AllofMerge',
            sourcemap: true,
        },
        plugins: jsPlugins
    },
];
