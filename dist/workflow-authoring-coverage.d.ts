import { WorkflowAuthoringProtection } from "./enums.js";
/** Exact installed guidance location retained for an authoring surface without model evidence. */
export interface ProtectedGuidanceSurface {
    path: string;
    anchor?: string;
    requiredText?: string;
}
/** Evidence and optimization policy for one stable workflow authoring surface. */
export interface WorkflowAuthoringCoverageEntry {
    id: string;
    kind: string;
    reference: {
        path: string;
        anchor?: string;
    };
    example?: string;
    behaviorEvidence: readonly string[];
    comprehensionScenarios: readonly string[];
    protection: WorkflowAuthoringProtection;
    protectedGuidance: readonly ProtectedGuidanceSurface[];
}
/** Scenario identifiers that release checks may accept as provider-backed evidence. */
export declare const WORKFLOW_COMPREHENSION_SCENARIO_IDS: string[];
/** Mixed guidance files that require explicit acceptance while behavioral coverage remains partial. */
export declare const WORKFLOW_AUTHORING_FROZEN_FILES: readonly [{
    readonly path: "skills/workflow-authoring/SKILL.md";
    readonly sha256: "7d9eae3326bf90af8b42bb6a0c92848c984638a9019e1524ed72ed51ac172a08";
}, {
    readonly path: "skills/workflow-authoring/references/runtime.md";
    readonly sha256: "a602af4fc6ebfeeab7ab9e089968864226bd37c85789f08508c73655595f1988";
}, {
    readonly path: "skills/workflow-authoring/references/helpers.md";
    readonly sha256: "1c8d253649f00412511f17ffc08c6156797b99de72ae037e14f2ea92ac33a11e";
}, {
    readonly path: "skills/workflow-authoring/references/specialized-helpers.md";
    readonly sha256: "ef95cc7fb9c68e55cb64cc7f63814df4059dbffa6c3d06f63f13d21819c4b863";
}, {
    readonly path: "skills/workflow-authoring/references/lifecycle.md";
    readonly sha256: "c3dfac1d2b0505f361f515fb21a5c55e0f97ca9d57bf7dc57eedcaab9500c580";
}, {
    readonly path: "skills/workflow-authoring/references/pattern-selection.md";
    readonly sha256: "923988a1b4d506a7b330bf5e4b8ab47cf8456edcfe6674b5d8d8848264633c3d";
}, {
    readonly path: "skills/workflow-authoring/references/focused-recipes.md";
    readonly sha256: "8cdacc3e659c2ce7bab7f73a311dc0d94ce1df5ed6fc7c66515e73e1bb8b157e";
}, {
    readonly path: "skills/workflow-authoring/references/registry-ownership.md";
    readonly sha256: "1fcff2bc3077efa58e6ed4e21c84d40bdb83ed49470f455d8753d3ae5d5c28e7";
}, {
    readonly path: "skills/workflow-authoring/references/review.md";
    readonly sha256: "2bd97acb87a8f6e9514892cdf5c431305b3d8952ba9761c1c203c217b08c9e7d";
}, {
    readonly path: "skills/workflow-authoring/references/debugging.md";
    readonly sha256: "080cf85ee2d41c064935ed64491a724b24b705dc40a7010af862fa22b733b71e";
}, {
    readonly path: "skills/workflow-authoring/examples/classify-and-act.js";
    readonly sha256: "23d0d9f37ee8648cd29ca526b0b23cf55bd3ac57efd02e1b93e227bcd0c18603";
}, {
    readonly path: "skills/workflow-authoring/examples/tournament.js";
    readonly sha256: "3a90bd3055c5e38e13fd8d7447173fc2e6a141fbc33b9bcc8a84723b7ab9d2e6";
}, {
    readonly path: "skills/workflow-authoring/examples/validated-gate.js";
    readonly sha256: "1cb4b3941ae61ebd1e12ada899f7d04678fe858a307c7fabc408603a4b9ba889";
}];
/** Stable orchestration-pattern identifiers covered by the authoring inventory. */
export declare const WORKFLOW_AUTHORING_PATTERN_IDS: readonly ["workflow.pattern.classify-and-act", "workflow.pattern.fan-out-and-synthesize", "workflow.pattern.adversarial-verification", "workflow.pattern.generate-and-filter", "workflow.pattern.tournament", "workflow.pattern.loop-until-done"];
/** Stable focused-recipe identifiers covered by the authoring inventory. */
export declare const WORKFLOW_AUTHORING_RECIPE_IDS: readonly ["workflow.recipe.phased-budgets", "workflow.recipe.saved-nested-workflows", "workflow.recipe.bounded-semantic-retry", "workflow.recipe.validator-feedback", "workflow.recipe.structured-output"];
/** Complete release-gated inventory of behavioral coverage and frozen authoring guidance. */
export declare const WORKFLOW_AUTHORING_COVERAGE: readonly WorkflowAuthoringCoverageEntry[];
