/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  rootDir: "apps/api",
  testRegex: ".*\\.test\\.ts$",
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  transform: {
    "^.+\\.ts$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2022",
          parser: { syntax: "typescript", decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
        module: { type: "commonjs" },
      },
    ],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  testTimeout: 60000,
};
