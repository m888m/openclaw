/** Config shape for `plugins.<id>.config.vllmPriority`. */
export type VllmPriorityConfig = {
  /** Master on/off switch. Defaults to true. */
  enabled?: boolean;
  /**
   * Provider ids (`models.providers.<id>`) this plugin claims for
   * `prepareExtraParams`. Required: OpenClaw resolves at most one provider
   * plugin per provider id, so a provider id must be listed here for this
   * plugin's classification/injection to run for it at all. Each configured
   * provider still needs the neutral `extraBody: { priority: 0 }` /
   * `extra_body: { priority: 0 }` opt-in marker on its model params (see
   * README) - listing a provider here only makes the plugin eligible to run
   * for it.
   */
  providers?: string[];
  /** Priority values per urgency lane. Defaults to `{ foreground: -100, normal: 0, background: 100 }`. */
  priorities?: {
    foreground?: number;
    normal?: number;
    background?: number;
  };
};

export const VLLM_PRIORITY_JSON_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vllmPriority: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        providers: { type: "array", items: { type: "string" } },
        priorities: {
          type: "object",
          additionalProperties: false,
          properties: {
            foreground: { type: "number" },
            normal: { type: "number" },
            background: { type: "number" },
          },
        },
      },
    },
  },
} as const;
