<script lang="ts">
  import type { Snippet } from 'svelte';
  import { currentRoute } from '../router';
  import { meInfo } from '../lib/auth';

  let { children }: { children?: Snippet } = $props();
</script>

<div class="app-container">
  <nav class="sidebar desktop-only" aria-label="Navegación principal">
    <ul>
      <li class:active={$currentRoute === 'hoy'}>
        <a href="#/hoy" aria-current={$currentRoute === 'hoy' ? 'page' : undefined}>Hoy</a>
      </li>
      <li class:active={$currentRoute === 'calendario'}>
        <a href="#/calendario" aria-current={$currentRoute === 'calendario' ? 'page' : undefined}>Calendario</a>
      </li>
      <li class:active={$currentRoute === 'notas'}>
        <a href="#/notas" aria-current={$currentRoute === 'notas' ? 'page' : undefined}>Notas</a>
      </li>
      <li class:active={$currentRoute === 'ajustes'}>
        <a href="#/ajustes" aria-current={$currentRoute === 'ajustes' ? 'page' : undefined}>Ajustes</a>
      </li>
    </ul>
  </nav>

  <main class="content">
    {@render children?.()}
    {#if $meInfo}
      <p class="server-info">Servidor v{$meInfo.version} · {$meInfo.tz}</p>
    {/if}
  </main>

  <nav class="bottom-nav mobile-only" aria-label="Navegación inferior">
    <ul>
      <li class:active={$currentRoute === 'hoy'}>
        <a href="#/hoy" aria-current={$currentRoute === 'hoy' ? 'page' : undefined}>
          <span class="icon" aria-hidden="true">📅</span>
          <span class="label">Hoy</span>
        </a>
      </li>
      <li class:active={$currentRoute === 'calendario'}>
        <a href="#/calendario" aria-current={$currentRoute === 'calendario' ? 'page' : undefined}>
          <span class="icon" aria-hidden="true">📆</span>
          <span class="label">Calendario</span>
        </a>
      </li>
      <li class:active={$currentRoute === 'notas'}>
        <a href="#/notas" aria-current={$currentRoute === 'notas' ? 'page' : undefined}>
          <span class="icon" aria-hidden="true">📝</span>
          <span class="label">Notas</span>
        </a>
      </li>
      <li class:active={$currentRoute === 'ajustes'}>
        <a href="#/ajustes" aria-current={$currentRoute === 'ajustes' ? 'page' : undefined}>
          <span class="icon" aria-hidden="true">⚙️</span>
          <span class="label">Ajustes</span>
        </a>
      </li>
    </ul>
  </nav>
</div>

<style>
  .app-container {
    display: flex;
    height: 100vh;
    flex-direction: column-reverse;
  }

  .sidebar {
    width: 250px;
    background-color: #f5f5f5;
    border-right: 1px solid #e0e0e0;
    padding: 0;
    margin: 0;
  }

  .sidebar ul {
    list-style: none;
    padding: 1rem 0;
    margin: 0;
  }

  .sidebar li {
    margin: 0;
    padding: 0;
  }

  .sidebar a {
    display: block;
    text-decoration: none;
    width: 100%;
    padding: 1rem 1.5rem;
    background: none;
    border: none;
    border-left: 4px solid transparent;
    text-align: left;
    cursor: pointer;
    font-size: 1rem;
    color: #666;
    transition: all 0.2s;
  }

  .sidebar a:hover {
    background-color: #e8e8e8;
    color: #333;
  }

  .sidebar li.active a {
    border-left-color: #4285f4;
    background-color: #e3f2fd;
    color: #4285f4;
    font-weight: 600;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 60px;
  }

  .server-info {
    margin: 0;
    padding: 0.5rem 1rem;
    font-size: 0.7rem;
    color: #999;
  }

  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: #fff;
    border-top: 1px solid #e0e0e0;
    padding: 0;
    margin: 0;
    z-index: 100;
  }

  .bottom-nav ul {
    display: flex;
    list-style: none;
    padding: 0;
    margin: 0;
    height: 60px;
  }

  .bottom-nav li {
    flex: 1;
    margin: 0;
    padding: 0;
    border-right: 1px solid #e0e0e0;
  }

  .bottom-nav li:last-child {
    border-right: none;
  }

  .bottom-nav a {
    text-decoration: none;
    width: 100%;
    height: 100%;
    background: none;
    border: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: #666;
    font-size: 0.75rem;
    gap: 0.25rem;
    transition: all 0.2s;
  }

  .bottom-nav a:active {
    background-color: #f5f5f5;
  }

  .bottom-nav li.active a {
    color: #4285f4;
  }

  .icon {
    font-size: 1.5rem;
  }

  .label {
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Desktop layout */
  @media (min-width: 769px) {
    .app-container {
      flex-direction: row;
    }

    .content {
      flex: 1;
      padding-bottom: 0;
    }

    .desktop-only {
      display: block;
    }

    .mobile-only {
      display: none;
    }
  }

  /* Mobile layout */
  @media (max-width: 768px) {
    .sidebar {
      display: none;
    }

    .desktop-only {
      display: none;
    }

    .mobile-only {
      display: block;
    }
  }
</style>
