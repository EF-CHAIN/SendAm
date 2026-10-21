import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import SystemHealth from './SystemHealth';
import { server } from '../mocks/server';

const HEALTH_URL = '*/api/admin/system-health';

// Mirrors the shape returned by adminController.getSystemHealth.
const healthyPayload = {
  api: 'ok',
  database: 'ok',
  queues: 'redis-configured',
  settlementRail: 'stellar',
  custodyModel: 'direct',
};

const renderHealth = () => render(<SystemHealth />);

const waitForHeading = () =>
  screen.findByRole('heading', { level: 1, name: 'System Health' });

// Each component renders as a card: the key label followed by its value.
const expectComponentStatus = (key, value) => {
  const label = screen.getByText(key);
  expect(label.nextElementSibling).toHaveTextContent(value);
};

describe('SystemHealth page', () => {
  it('shows a loader until the health check resolves', async () => {
    renderHealth();
    expect(screen.queryByRole('heading', { name: 'System Health' })).not.toBeInTheDocument();
    await waitForHeading();
  });

  it('renders every component as ok when the system is healthy', async () => {
    server.use(http.get(HEALTH_URL, () => HttpResponse.json({ data: healthyPayload })));

    renderHealth();
    await waitForHeading();

    Object.entries(healthyPayload).forEach(([key, value]) => {
      expectComponentStatus(key, value);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces the failing component when the system is degraded', async () => {
    server.use(
      http.get(HEALTH_URL, () =>
        HttpResponse.json({
          data: { ...healthyPayload, database: 'down', queues: 'unavailable' },
        })
      )
    );

    renderHealth();
    await waitForHeading();

    expectComponentStatus('api', 'ok');
    expectComponentStatus('database', 'down');
    expectComponentStatus('queues', 'unavailable');
    // A degraded report is still a successful fetch, not an error state.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a sanitized alert when the health endpoint returns a server error', async () => {
    server.use(
      http.get(HEALTH_URL, () =>
        HttpResponse.json(
          { message: 'pg: connection refused at 10.0.0.5:5432' },
          { status: 500 }
        )
      )
    );

    renderHealth();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A server error occurred. Our team has been notified.');
    // Raw backend details must never reach the UI.
    expect(alert).not.toHaveTextContent(/connection refused|10\.0\.0\.5/);
    expect(screen.getByRole('heading', { level: 1, name: 'System Health' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a network alert when the request cannot reach the API', async () => {
    server.use(http.get(HEALTH_URL, () => HttpResponse.error()));

    renderHealth();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A network error occurred. Please check your connection and try again.'
    );
  });

  it('refetches and recovers when the operator retries after an error', async () => {
    let calls = 0;
    server.use(
      http.get(HEALTH_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ message: 'boom' }, { status: 503 });
        }
        return HttpResponse.json({ data: healthyPayload });
      })
    );

    const user = userEvent.setup();
    renderHealth();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await screen.findByText('database');
    expectComponentStatus('database', 'ok');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls).toBe(2);
  });
});
