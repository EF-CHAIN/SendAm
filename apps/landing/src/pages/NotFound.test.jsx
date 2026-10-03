import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotFound from './NotFound.jsx';

function renderNotFound() {
  return render(
    <MemoryRouter initialEntries={['/definitely-not-a-real-page']}>
      <NotFound />
    </MemoryRouter>
  );
}

describe('NotFound', () => {
  it('renders a clear 404 heading', () => {
    renderNotFound();
    expect(screen.getByRole('heading', { name: /404/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });

  it('explains what happened in plain words', () => {
    renderNotFound();
    expect(screen.getByText(/does not exist or has been moved/i)).toBeInTheDocument();
  });

  it('links back to the home page with the correct href', () => {
    renderNotFound();
    expect(screen.getByRole('link', { name: /return home/i })).toHaveAttribute('href', '/');
  });
});
