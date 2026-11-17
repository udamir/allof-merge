import babel from '@rollup/plugin-babel';
import filesize from 'rollup-plugin-filesize';
import progress from 'rollup-plugin-progress';
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import { createRequire } from 'module';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

// package.json is read through require: an ESM json import needs an import attribute on current Node versions
const pkg = createRequire(import.meta.url)('./package.json');

const inputPath = './src'

const preamble = `/*!
 * allof-merge v${pkg.version}
 * Copyright (C) 2012-${new Date().getFullYear()} ${pkg.author}
 * Date: ${new Date().toUTCString()}
 */`;

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
    terser({ format: { 
        preamble,
        comments: false
    } })
];

function makeConfig(file, format) {
    return {
        input: `${inputPath}/index.ts`,
        output: {
            file,
            format,
            name: 'AllofMerge',
            sourcemap: true,
        },
        plugins: jsPlugins
    };
}

export default [
    makeConfig(pkg.main, 'umd'),
    makeConfig(pkg.module, 'esm'),
    makeConfig(pkg.browser, 'iife'),
];
