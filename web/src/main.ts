import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/base.css';
import App from './App.svelte';

// El registro del service worker lo inyecta vite-plugin-pwa (injectRegister: 'auto').
const app = mount(App, { target: document.getElementById('app')! });

export default app;
