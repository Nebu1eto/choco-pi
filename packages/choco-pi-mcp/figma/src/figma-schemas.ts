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

export const FigmaGetFileParams = obj({
  file_key: FileKeySchema,
  depth: opt(num({ description: "Optional Figma file depth query parameter", minimum: 1 })),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaGetDesignContextParams = obj({
  file_key: FileKeySchema,
  node_id: opt(NodeIdSchema),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaGetNodesParams = obj({
  file_key: FileKeySchema,
  node_ids: NodeIdsSchema,
  max_response_chars: MaxResponseCharsSchema,
});

const FigmaNodeProcessingOptions = {
  depth: opt(
    num({
      description:
        "How many levels of node hierarchy to include. Defaults to 2 and is capped at 4.",
      minimum: 1,
      maximum: 4,
    }),
  ),
  include_hidden: opt(
    bool({ description: "Include nodes where visible=false. Defaults to false." }),
  ),
  include_vectors: opt(bool({ description: "Include vector/icon internals. Defaults to false." })),
  include_component_internals: opt(
    bool({ description: "Expand component instance internals. Defaults to false." }),
  ),
};

const RenderFormatSchema = oneOf(["png", "jpg", "svg", "pdf"], {
  description: "Rendered asset format",
});
const FrameworkSchema = oneOf(["react", "html", "vue", "angular", "react-native"]);
const StylingSchema = oneOf(["css", "css-modules", "styled-components", "tailwind", "inline"]);
const AssetTypeSchema = oneOf(["svg_icons", "node_renders", "image_fills"]);

const FigmaOptionalRenderOptions = {
  render_image: opt(
    bool({
      description:
        "Render the node and include image URL/local path in the response. Defaults to false.",
    }),
  ),
  output_dir: opt(
    str({
      description:
        "Optional directory for downloaded rendered image files. Omit unless the user requested persistent files; by default downloads go to an OS temp directory.",
    }),
  ),
  format: opt(RenderFormatSchema),
  scale: opt(num({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
};

export const FigmaProcessedNodeParams = obj({
  file_key: FileKeySchema,
  node_id: NodeIdSchema,
  ...FigmaNodeProcessingOptions,
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaProcessedNodeWithRenderParams = obj({
  file_key: FileKeySchema,
  node_id: NodeIdSchema,
  ...FigmaNodeProcessingOptions,
  ...FigmaOptionalRenderOptions,
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaImplementationContextParams = obj({
  file_key: FileKeySchema,
  node_id: NodeIdSchema,
  ...FigmaNodeProcessingOptions,
  ...FigmaOptionalRenderOptions,
  framework: opt(FrameworkSchema),
  styling: opt(StylingSchema),
  resolve_tokens: opt(
    bool({
      description:
        "Resolve style and variable IDs into token names when possible. Defaults to true.",
    }),
  ),
  include_code_snippets: opt(
    bool({
      description:
        "Include compact starter snippets for the selected framework/styling target. Defaults to false.",
    }),
  ),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaSingleFileParams = obj({
  file_key: FileKeySchema,
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaSearchComponentsParams = obj({
  file_key: FileKeySchema,
  query: str({ description: "Case-insensitive component name/description search term" }),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaFindNodesParams = obj({
  file_key: FileKeySchema,
  query: str({ description: "Layer name or visible text query" }),
  node_id: opt(NodeIdSchema),
  ...FigmaNodeProcessingOptions,
  exact: opt(
    bool({
      description: "Require an exact match instead of substring matching. Defaults to false.",
    }),
  ),
  case_sensitive: opt(bool({ description: "Use case-sensitive matching. Defaults to false." })),
  max_results: opt(
    num({
      description: "Maximum matches to return. Defaults to 50 and is capped at 200.",
      minimum: 1,
      maximum: 200,
    }),
  ),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaRenderNodesParams = obj({
  file_key: FileKeySchema,
  node_ids: NodeIdsSchema,
  output_dir: opt(
    str({
      description:
        "Optional directory for downloaded image files. Omit unless the user requested persistent files; if omitted, an OS temp directory is created.",
    }),
  ),
  format: opt(RenderFormatSchema),
  scale: opt(num({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
  download: opt(bool({ description: "Download rendered assets locally. Defaults to true." })),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaExtractAssetsParams = obj({
  file_key: FileKeySchema,
  node_id: NodeIdSchema,
  depth: opt(
    num({
      description:
        "How many levels of node hierarchy to inspect for assets. Defaults to 3 and is capped at 4.",
      minimum: 1,
      maximum: 4,
    }),
  ),
  asset_types: opt(
    arr(AssetTypeSchema, {
      description: "Asset categories to extract. Defaults to all supported categories.",
    }),
  ),
  output_dir: opt(
    str({
      description:
        "Optional directory for downloaded asset files. Omit unless the user requested persistent files; by default files go to an OS temp directory.",
    }),
  ),
  include_hidden: opt(
    bool({
      description: "Include hidden nodes while discovering assets. Defaults to false.",
    }),
  ),
  max_assets: opt(
    num({
      description: "Maximum assets to include in the manifest. Defaults to 80.",
      minimum: 1,
      maximum: 500,
    }),
  ),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaFindCodeConnectMappingParams = obj({
  file_key: FileKeySchema,
  node_id: opt(NodeIdSchema),
  component_key: opt(str({ description: "Optional Figma component key to search for locally." })),
  root_dir: opt(
    str({
      description: "Optional directory under the current repo to scan. Defaults to cwd.",
    }),
  ),
  max_matches: opt(
    num({
      description: "Maximum local mapping matches to return. Defaults to 40.",
      minimum: 1,
      maximum: 200,
    }),
  ),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaComponentImplementationHintsParams = obj({
  file_key: FileKeySchema,
  node_id: NodeIdSchema,
  ...FigmaNodeProcessingOptions,
  framework: opt(FrameworkSchema),
  styling: opt(StylingSchema),
  include_code_connect: opt(
    bool({
      description: "Scan the local repo for Figma Code Connect mappings. Defaults to true.",
    }),
  ),
  include_snippet: opt(
    bool({ description: "Include starter framework snippet. Defaults to false." }),
  ),
  root_dir: opt(
    str({ description: "Optional local repo subdirectory for Code Connect scanning." }),
  ),
  max_response_chars: MaxResponseCharsSchema,
});

export const FigmaParseUrlParams = obj({
  url: str({ description: "Figma design/file URL" }),
});
