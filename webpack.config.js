//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node',

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  plugins: [
    // ssh2's native addons are optional (it falls back to pure JS). On Linux CI
    // `npm ci` compiles them, producing .node binaries webpack can't bundle.
    // Ignore them so the bundle uses the JS fallback on every platform.
    new webpack.IgnorePlugin({ resourceRegExp: /^cpu-features$/ }),
    new webpack.IgnorePlugin({ resourceRegExp: /\.node$/ }),
  ],
};

module.exports = config;
