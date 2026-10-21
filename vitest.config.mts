import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		setupFiles: ["./test/setup.ts"],
		poolOptions: {
			workers: {
				// The `test` environment redeclares the D1 and R2 bindings without
				// `remote: true`, so the suite runs entirely on Miniflare's local
				// storage instead of proxying to the real Cloudflare account.
				wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
			},
		},
	},
});
