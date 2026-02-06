import React from 'react';

/**
 * Composes multiple React context providers into a single wrapper component.
 * Eliminates deeply nested provider trees in favor of a flat list.
 *
 * @param  {...[Component, props?]} providers - Array of [Provider, props] tuples
 * @returns {React.FC} A single component that wraps children in all providers
 *
 * @example
 * const Providers = composeProviders(
 *   [ThemeProvider],
 *   [AuthProvider],
 *   [I18nextProvider, { i18n }],
 * );
 * // <Providers><App /></Providers>
 */
export default function composeProviders(...providers) {
  return function ComposedProviders({ children }) {
    return providers.reduceRight(
      (acc, [Provider, props]) => <Provider {...props}>{acc}</Provider>,
      children
    );
  };
}
