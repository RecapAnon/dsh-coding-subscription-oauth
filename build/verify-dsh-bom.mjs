import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const matrix = JSON.parse(await readFile(resolve(root, "compatibility", "dsh-bom.json"), "utf8"));
const bom = manifest?.dsh?.compatibility?.bom;
if (typeof bom !== "object" || bom === null || Array.isArray(bom)) {
	throw new Error("package.json dsh.compatibility.bom is required");
}

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const isDshRuntimePackage = (name) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
const failures = [];
if (manifest?.dsh?.compatibility?.coreAbi !== "dsh-coding-oauth-core/v1") {
	failures.push("dsh.compatibility.coreAbi must match the shared OAuth core ABI");
}
if (manifest?.dsh?.compatibility?.verifiedBom !== "./compatibility/dsh-bom.json") {
	failures.push("dsh.compatibility.verifiedBom must point to the packaged matrix");
}
if (matrix?.schemaVersion !== 1 || matrix?.coreAbi !== manifest?.dsh?.compatibility?.coreAbi) {
	failures.push("compatibility matrix schema/core ABI does not match package metadata");
}
if (JSON.stringify(matrix?.verified?.packages) !== JSON.stringify(bom)) {
	failures.push("compatibility matrix verified packages must exactly match dsh.compatibility.bom");
}
if (!Array.isArray(matrix?.candidates) || matrix.candidates.some((candidate) => candidate?.status !== "unverified")) {
	failures.push("every untested DSH candidate must remain explicitly unverified");
}

// The supported range is the single source of truth for every DSH runtime peer.
// DSH applies `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
// at profile startup, so the range must admit the verified host under those rules.
const supportedRange = matrix?.supportedDshRange;
if (typeof supportedRange !== "string" || semver.validRange(supportedRange) === null) {
	failures.push("compatibility matrix supportedDshRange must be a valid semver range");
} else {
	if (exactVersionPattern.test(supportedRange)) {
		failures.push(
			`supportedDshRange must be a range, not the exact pin ${supportedRange}: an exact pin makes every later DSH release deny the plugin at profile startup`,
		);
	}
	const verifiedVersion = matrix?.verified?.dshVersion;
	if (typeof verifiedVersion !== "string" || semver.valid(verifiedVersion) === null) {
		failures.push("compatibility matrix verified.dshVersion must be an exact semantic version");
	} else if (!semver.satisfies(verifiedVersion, supportedRange, { includePrerelease: true })) {
		failures.push(`supportedDshRange ${supportedRange} does not admit the verified host ${verifiedVersion}`);
	}
}

for (const [name, expected] of Object.entries(bom)) {
	if (typeof expected !== "string" || !exactVersionPattern.test(expected)) {
		failures.push(`${name}: BOM version must be an exact release version`);
		continue;
	}
	// The BOM records the exact versions this release was built and tested against,
	// so the development/test closure must reproduce it byte-for-byte.
	const devDeclared = manifest.devDependencies?.[name];
	if (devDeclared === undefined) {
		failures.push(`${name}: missing from devDependencies (the BOM must be reproducible)`);
	} else if (devDeclared !== expected) {
		failures.push(`devDependencies.${name}: expected ${expected}, found ${devDeclared}`);
	}

	const runtimeDeclared = manifest.dependencies?.[name];
	if (runtimeDeclared !== undefined && runtimeDeclared !== expected) {
		failures.push(`dependencies.${name}: expected ${expected}, found ${runtimeDeclared}`);
	}

	// Peers describe the hosts this plugin accepts, which is deliberately wider
	// than the single host it was verified on.
	const peerDeclared = manifest.peerDependencies?.[name];
	if (peerDeclared === undefined) continue;
	if (semver.validRange(peerDeclared) === null) {
		failures.push(`peerDependencies.${name}: ${peerDeclared} is not a valid semver range`);
		continue;
	}
	if (exactVersionPattern.test(peerDeclared)) {
		failures.push(
			`peerDependencies.${name}: exact pin ${peerDeclared} is forbidden; pin the tested version in the BOM and accept a range here`,
		);
		continue;
	}
	if (!semver.satisfies(expected, peerDeclared, { includePrerelease: true })) {
		failures.push(`peerDependencies.${name}: range ${peerDeclared} does not admit the verified ${expected}`);
		continue;
	}
	if (isDshRuntimePackage(name) && peerDeclared !== supportedRange) {
		failures.push(
			`peerDependencies.${name}: expected the shared supportedDshRange ${supportedRange}, found ${peerDeclared}`,
		);
	}
}

const dshRuntimePackages = new Set(
	["dependencies", "peerDependencies", "devDependencies"].flatMap((section) =>
		Object.keys(manifest[section] ?? {}).filter(
			(name) =>
				name.startsWith("@deepseek-ai/") ||
				name === "@earendil-works/pi-ai" ||
				name === "react" ||
				name === "react-dom",
		),
	),
);
for (const name of dshRuntimePackages) {
	if (!(name in bom)) failures.push(`${name}: missing from dsh.compatibility.bom`);
}

if (failures.length > 0) {
	throw new Error(`DSH BOM gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}
console.log(
	`verified DSH BOM (${String(Object.keys(bom).length)} packages) against host ${matrix.verified.dshVersion}, accepting ${supportedRange}`,
);
