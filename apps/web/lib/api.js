import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3002/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

export default api;
