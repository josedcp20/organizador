import { mount } from 'svelte';
import App from './App.svelte';

// El registro del service worker lo inyecta vite-plugin-pwa (injectRegister: 'auto').
const app = mount(App, { target: document.getElementById('app')! });

export default app;
