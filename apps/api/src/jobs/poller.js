let timer = null;

const startPoller = (intervalMs = 5000) => {
  if (timer) return; // Already running!
  console.log('Deposit poller started.');
  timer = setInterval(() => {
    // Poller tick logic goes here
  }, intervalMs);
};

const stopPoller = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('Deposit poller stopped.');
  }
};

const isPollerRunning = () => timer !== null;

module.exports = {
  startPoller,
  stopPoller,
  isPollerRunning,
};