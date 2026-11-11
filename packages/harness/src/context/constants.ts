/**
 * Every numeric value of context management, in estimated tokens unless a
 * name says otherwise. No other module writes one of these as a literal.
 */

/** Characters per estimated token, for every model. */
export const CHARACTERS_PER_TOKEN = 4

/** The most of a model's context window a checkpoint window takes when nothing configures its size. */
export const CHECKPOINT_WINDOW_CAP = 480_000

/** The harness instructions' allowance in the harness seed. */
export const HARNESS_INSTRUCTIONS_ALLOWANCE = 4_000
/** The user instructions component's allowance. */
export const USER_INSTRUCTIONS_ALLOWANCE = 12_000
/** The skill catalog component's allowance. */
export const SKILL_CATALOG_ALLOWANCE = 4_000
/** The code mode catalog component's allowance. */
export const CODE_MODE_CATALOG_ALLOWANCE = 4_000
/** The session facts component's allowance. */
export const SESSION_FACTS_ALLOWANCE = 2_000
/** The session checkpoint's timelines allowance, its heading, introduction, and timelines sections' text included. */
export const TIMELINES_ALLOWANCE = 60_000
/** The session checkpoint's recent transcript allowance, its section's heading and explanation included. */
export const RECENT_TRANSCRIPT_ALLOWANCE = 20_000
/** The session checkpoint component's allowance. */
export const CHECKPOINT_ALLOWANCE = TIMELINES_ALLOWANCE + RECENT_TRANSCRIPT_ALLOWANCE
/** The harness seed's allowance: harness instructions and every seed component. */
export const SEED_ALLOWANCE =
  HARNESS_INSTRUCTIONS_ALLOWANCE +
  USER_INSTRUCTIONS_ALLOWANCE +
  SKILL_CATALOG_ALLOWANCE +
  CODE_MODE_CATALOG_ALLOWANCE +
  SESSION_FACTS_ALLOWANCE +
  CHECKPOINT_ALLOWANCE

/** The allowance of the tool definitions a model call offers: names, descriptions, and parameter schemas. */
export const TOOL_DEFINITIONS_ALLOWANCE = 4_000
/** The part of the checkpoint window size whose shortfall starts a context turn. */
export const RESERVE = 40_000
/** The least a checkpoint window size may leave after the seed, the tool definitions, and the reserve. */
export const WORKING_MARGIN = 100_000

/** The estimate of one image in a model call's input. */
export const IMAGE_TOKENS = 1_500

/** The characters of a new session id. */
export const SESSION_ID_LENGTH = 12

/** The characters of an agent title, the key of its `agents` entry. */
export const TITLE_MAX_LENGTH = 64
/** The characters of a title file's `description:`. */
export const TITLE_DESCRIPTION_MAX_LENGTH = 1_024

/** The Unicode code points of an entry field, a secondary timeline's description and path, and a research file's description. */
export const ENTRY_FIELD_MAX_LENGTH = 120
/** The entries one `context_append` call appends at most. */
export const APPEND_MAX_ENTRIES = 16
/** The entries one done entry resolves at most. */
export const RESOLVES_MAX_ENTRIES = 16

/** The questions one `context_ask_question` call asks at most. */
export const QUESTIONS_MAX = 3
/** The characters of a question's header. */
export const QUESTION_HEADER_MAX_LENGTH = 12
/** The characters of a question. */
export const QUESTION_MAX_LENGTH = 240
/** The fewest and most options of a question. */
export const QUESTION_OPTIONS_MIN = 2
export const QUESTION_OPTIONS_MAX = 3
/** The characters of an option's label. */
export const OPTION_LABEL_MAX_LENGTH = 40
/** The characters of an option's description. */
export const OPTION_DESCRIPTION_MAX_LENGTH = 120
/** The characters of a user note and of a call's feedback. */
export const NOTE_MAX_LENGTH = 2_000

/** The size at which an open chat boundary closes. */
export const CHAT_BOUNDARY_CLOSE = 60_000
/** The output tokens a compaction or handoff call asks for at most. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 8_000
/** The Unicode code points of a research entry's summary. */
export const RESEARCH_SUMMARY_MAX_LENGTH = 240
/** The characters a research call's diff or content keeps from each end. */
export const RESEARCH_INPUT_CLIP = 16_000

/** The memory files a memory draft holds at most. */
export const MEMORY_FILES_MAX = 64
/** The validations a context turn fails before it falls back. */
export const VALIDATION_ATTEMPTS = 3
/** The shares of the clearable results' tokens that a context turn's first, second, and third clearings free. */
export const CLEARING_SHARES = [0.25, 0.5, 1] as const
/** The characters a handoff transcript's tool output keeps from each end at its first shortening level. */
export const HANDOFF_TOOL_OUTPUT_CLIP = 2_000

/** The bytes of apparent file size a fork copies from its source's scratch at most. */
export const SCRATCH_FORK_MAX_BYTES = 2 * 1024 ** 3

/** Estimated tokens of `text`: its characters divided by four, rounded up. */
export const estimateTokens = (text: string) => Math.ceil(text.length / CHARACTERS_PER_TOKEN)
