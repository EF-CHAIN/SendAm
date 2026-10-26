// Dynamic imports for the heavy, below-the-fold landing sections. Each call
// site becomes its own chunk; Home.jsx wraps them in React.lazy.
export const loadCurrencyCalculator = () => import('@/components/CurrencyCalculator.jsx');
export const loadCorridorGlobe = () => import('@/components/CorridorGlobe.jsx');
