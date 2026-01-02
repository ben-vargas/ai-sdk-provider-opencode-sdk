import type { Logger } from "./types.js";

/**
 * Default console-based logger.
 */
export const defaultLogger: Logger = {
  warn: (message: string) => {
    console.warn(`[opencode-provider] ${message}`);
  },
  error: (message: string) => {
    console.error(`[opencode-provider] ${message}`);
  },
  debug: (message: string) => {
    console.debug(`[opencode-provider] ${message}`);
  },
};

/**
 * Silent logger that discards all messages.
 */
export const silentLogger: Logger = {
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Get a logger instance.
 * @param logger - Logger instance, false to disable, or undefined for default
 * @param verbose - Enable verbose/debug logging
 */
export function getLogger(
  logger: Logger | false | undefined,
  verbose?: boolean,
): Logger {
  if (logger === false) {
    return silentLogger;
  }

  if (logger) {
    // If verbose is enabled and the provided logger has debug, use it
    // Otherwise, wrap to add debug support
    if (verbose && !logger.debug) {
      return {
        ...logger,
        debug: (message: string) => logger.warn(`[DEBUG] ${message}`),
      };
    }
    return logger;
  }

  // Use default logger, potentially with debug disabled
  if (!verbose) {
    return {
      ...defaultLogger,
      debug: () => {},
    };
  }

  return defaultLogger;
}

/**
 * Create a verbose logger that prefixes all messages with a context.
 */
export function createContextLogger(
  baseLogger: Logger,
  context: string,
): Logger {
  return {
    warn: (message: string) => baseLogger.warn(`[${context}] ${message}`),
    error: (message: string) => baseLogger.error(`[${context}] ${message}`),
    debug: baseLogger.debug
      ? (message: string) => baseLogger.debug!(`[${context}] ${message}`)
      : undefined,
  };
}

/**
 * Log a warning about an unsupported feature.
 */
export function logUnsupportedFeature(
  logger: Logger,
  feature: string,
  details?: string,
): void {
  const message = details
    ? `Unsupported feature: ${feature} - ${details}`
    : `Unsupported feature: ${feature}`;
  logger.warn(message);
}

/**
 * Log a warning about an unsupported parameter.
 */
export function logUnsupportedParameter(
  logger: Logger,
  parameter: string,
  value?: unknown,
): void {
  if (value !== undefined) {
    logger.warn(
      `Parameter '${parameter}' is not supported by OpenCode (value: ${JSON.stringify(value)})`,
    );
  } else {
    logger.warn(`Parameter '${parameter}' is not supported by OpenCode`);
  }
}

/**
 * Log unsupported call options.
 * Returns an array of warning messages for inclusion in the response.
 */
export function logUnsupportedCallOptions(
  logger: Logger,
  options: {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    seed?: number;
    maxTokens?: number;
  },
): string[] {
  const warnings: string[] = [];

  const unsupportedParams = [
    { name: "temperature", value: options.temperature },
    { name: "topP", value: options.topP },
    { name: "topK", value: options.topK },
    { name: "frequencyPenalty", value: options.frequencyPenalty },
    { name: "presencePenalty", value: options.presencePenalty },
    { name: "stopSequences", value: options.stopSequences },
    { name: "seed", value: options.seed },
    { name: "maxTokens", value: options.maxTokens },
  ];

  for (const param of unsupportedParams) {
    if (param.value !== undefined) {
      const warning = `Parameter '${param.name}' is not supported by OpenCode`;
      logger.warn(warning);
      warnings.push(warning);
    }
  }

  return warnings;
}
