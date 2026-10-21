import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('renders the friendly responsive illustration with decorative vector elements', () => {
    const { container } = renderNotFound();
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('text')?.textContent).toBe('404');
  });

  it('renders quick action recovery buttons leading to popular sections', () => {
    renderNotFound();
    expect(screen.getByRole('link', { name: /go to calculator/i })).toHaveAttribute('href', '/#calculator');
    expect(screen.getByRole('link', { name: /check onboarding status/i })).toHaveAttribute('href', '/onboarding');
    expect(screen.getByRole('link', { name: /browse faq/i })).toHaveAttribute('href', '/#faq');
  });

  it('filters available recovery routes in real-time when searching', () => {
    renderNotFound();
    const searchInput = screen.getByLabelText(/search available routes/i);

    // Initial state: no search results dropdown
    expect(screen.queryByRole('region')).toBeNull();

    // Search for "calc"
    fireEvent.change(searchInput, { target: { value: 'calc' } });
    expect(screen.getByRole('region')).toBeInTheDocument();
    const calcLink = screen.getByRole('link', { name: /currency calculator/i });
    expect(calcLink).toHaveAttribute('href', '/#calculator');

    // Search for non-existent keyword
    fireEvent.change(searchInput, { target: { value: 'xyz123random' } });
    expect(screen.getByText(/no matching routes found/i)).toBeInTheDocument();

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.queryByRole('region')).toBeNull();
  });
});
