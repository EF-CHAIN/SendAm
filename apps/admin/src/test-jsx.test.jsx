import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

describe('JSX test', () => {
  it('renders a div', () => {
    const { getByText } = render(<div>Test</div>);
    expect(getByText('Test')).toBeInTheDocument();
  });
});
