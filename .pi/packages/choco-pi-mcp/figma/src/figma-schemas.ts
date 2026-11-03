import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

export const MaxResponseCharsSchema = opt(
  num({
    description: "Maximum characters returned to the model before truncation",
    minimum: 1,
  }),
);

export const FileKeySchema = str({ description: "Figma file key from a Figma URL" });
export const NodeIdSchema = str({
  description: "Figma node ID, either 1:2 API format or 1-2 URL format",
});
export const NodeIdsSchema = arr(NodeIdSchema, {
  description: "One or more Figma node IDs. Batch related nodes in one call.",
  minItems: 1,
});

export const FigmaGetFileParams = obj(
  {
    fileKey: FileKeySchema,
    depth: opt(num({ description: "Optional Figma file depth query parameter", minimum: 1 })),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaGetDesignContextParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: opt(NodeIdSchema),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaGetNodesParams = obj(
  {
    fileKey: FileKeySchema,
    nodeIds: NodeIdsSchema,
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

const FigmaNodeProcessingOptions = {
  depth: opt(
    num({
      description:
        "How many levels of node hierarchy to include. Defaults to 2 and is capped at 4.",
      minimum: 1,
      maximum: 4,
    }),
  ),
  includeHidden: opt(
    bool({ description: "Include nodes where visible=false. Defaults to false." }),
  ),
  includeVectors: opt(bool({ description: "Include vector/icon internals. Defaults to false." })),
  includeComponentInternals: opt(
    bool({ description: "Expand component instance internals. Defaults to false." }),
  ),
};

const RenderFormatSchema = oneOf(["png", "jpg", "svg", "pdf"], {
  description: "Rendered asset format",
});
const FrameworkSchema = oneOf(["react", "html", "vue", "angular", "react-native"]);
const StylingSchema = oneOf(["css", "css-modules", "styled-components", "tailwind", "inline"]);
const AssetTypeSchema = oneOf(["svgIcons", "nodeRenders", "imageFills"]);

const FigmaOptionalRenderOptions = {
  renderImage: opt(
    bool({
      description:
        "Render the node and include image URL/local path in the response. Defaults to false.",
    }),
  ),
  outputDir: opt(
    str({
      description:
        "Optional directory for downloaded rendered image files. Omit unless the user requested persistent files; by default downloads go to an OS temp directory.",
    }),
  ),
  format: opt(RenderFormatSchema),
  scale: opt(num({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
};

export const FigmaProcessedNodeParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: NodeIdSchema,
    ...FigmaNodeProcessingOptions,
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaProcessedNodeWithRenderParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: NodeIdSchema,
    ...FigmaNodeProcessingOptions,
    ...FigmaOptionalRenderOptions,
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaImplementationContextParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: NodeIdSchema,
    ...FigmaNodeProcessingOptions,
    ...FigmaOptionalRenderOptions,
    framework: opt(FrameworkSchema),
    styling: opt(StylingSchema),
    resolveTokens: opt(
      bool({
        description:
          "Resolve style and variable IDs into token names when possible. Defaults to true.",
      }),
    ),
    includeCodeSnippets: opt(
      bool({
        description:
          "Include compact starter snippets for the selected framework/styling target. Defaults to false.",
      }),
    ),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaSingleFileParams = obj(
  {
    fileKey: FileKeySchema,
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaSearchComponentsParams = obj(
  {
    fileKey: FileKeySchema,
    query: str({ description: "Case-insensitive component name/description search term" }),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaFindNodesParams = obj(
  {
    fileKey: FileKeySchema,
    query: str({ description: "Layer name or visible text query" }),
    nodeId: opt(NodeIdSchema),
    ...FigmaNodeProcessingOptions,
    exact: opt(
      bool({
        description: "Require an exact match instead of substring matching. Defaults to false.",
      }),
    ),
    caseSensitive: opt(bool({ description: "Use case-sensitive matching. Defaults to false." })),
    maxResults: opt(
      num({
        description: "Maximum matches to return. Defaults to 50 and is capped at 200.",
        minimum: 1,
        maximum: 200,
      }),
    ),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaRenderNodesParams = obj(
  {
    fileKey: FileKeySchema,
    nodeIds: NodeIdsSchema,
    outputDir: opt(
      str({
        description:
          "Optional directory for downloaded image files. Omit unless the user requested persistent files; if omitted, an OS temp directory is created.",
      }),
    ),
    format: opt(RenderFormatSchema),
    scale: opt(num({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
    download: opt(bool({ description: "Download rendered assets locally. Defaults to true." })),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaExtractAssetsParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: NodeIdSchema,
    depth: opt(
      num({
        description:
          "How many levels of node hierarchy to inspect for assets. Defaults to 3 and is capped at 4.",
        minimum: 1,
        maximum: 4,
      }),
    ),
    assetTypes: opt(
      arr(AssetTypeSchema, {
        description: "Asset categories to extract. Defaults to all supported categories.",
      }),
    ),
    outputDir: opt(
      str({
        description:
          "Optional directory for downloaded asset files. Omit unless the user requested persistent files; by default files go to an OS temp directory.",
      }),
    ),
    includeHidden: opt(
      bool({
        description: "Include hidden nodes while discovering assets. Defaults to false.",
      }),
    ),
    maxAssets: opt(
      num({
        description: "Maximum assets to include in the manifest. Defaults to 80.",
        minimum: 1,
        maximum: 500,
      }),
    ),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaFindCodeConnectMappingParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: opt(NodeIdSchema),
    componentKey: opt(str({ description: "Optional Figma component key to search for locally." })),
    rootDir: opt(
      str({
        description: "Optional directory under the current repo to scan. Defaults to cwd.",
      }),
    ),
    maxMatches: opt(
      num({
        description: "Maximum local mapping matches to return. Defaults to 40.",
        minimum: 1,
        maximum: 200,
      }),
    ),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaComponentImplementationHintsParams = obj(
  {
    fileKey: FileKeySchema,
    nodeId: NodeIdSchema,
    ...FigmaNodeProcessingOptions,
    framework: opt(FrameworkSchema),
    styling: opt(StylingSchema),
    includeCodeConnect: opt(
      bool({
        description: "Scan the local repo for Figma Code Connect mappings. Defaults to true.",
      }),
    ),
    includeSnippet: opt(
      bool({ description: "Include starter framework snippet. Defaults to false." }),
    ),
    rootDir: opt(
      str({ description: "Optional local repo subdirectory for Code Connect scanning." }),
    ),
    maxResponseChars: MaxResponseCharsSchema,
  },
  { open: true },
);

export const FigmaParseUrlParams = obj(
  {
    url: str({ description: "Figma design/file URL" }),
  },
  { open: true },
);
