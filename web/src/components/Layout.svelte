<script lang="ts">
  import type { Snippet } from 'svelte';
  import { currentRoute } from '../router';
  import { meInfo } from '../lib/auth';

  // children: la pantalla. sidebar: zona bajo el menu lateral de escritorio (filtro de calendarios).
  let { children, sidebar }: { children?: Snippet; sidebar?: Snippet } = $props();

  // Iconos de trazo 24x24 (stroke currentColor).
  const items = [
    { route: 'hoy', label: 'Hoy', icon: 'M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM12 13.5h.01' },
    { route: 'calendario', label: 'Calendario', icon: 'M4 5h16v15H4zM4 10h16M4 15h16M9.3 10v10M14.7 10v10M8 3v3M16 3v3' },
    { route: 'notas', label: 'Notas', icon: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5' },
    { route: 'ajustes', label: 'Ajustes', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4' },
  ] as const;
</script>

{#snippet icon(d: string)}
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"><path {d} /></svg
  >
{/snippet}

{#snippet plus()}
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
  </svg>
{/snippet}

<div class="shell">
  <aside class="side">
    <p class="brand">Organizador</p>
    <nav aria-label="Navegación principal">
      <ul>
        {#each items as it (it.route)}
          {@const active = $currentRoute === it.route}
          <li>
            <a href={`#/${it.route}`} class="side-link" aria-current={active ? 'page' : undefined}>
              {@render icon(it.icon)}
              <span class:mark={active}>{it.label}</span>
            </a>
          </li>
        {/each}
      </ul>
    </nav>
    <a class="btn btn-primary side-quick" href="#/nota-rapida">{@render plus()} Nota rápida</a>
    {#if sidebar}
      <div class="side-extra">{@render sidebar()}</div>
    {/if}
  </aside>

  <main class="main">
    <div class="page">
      {@render children?.()}
    </div>
    {#if $meInfo}
      <p class="server-info">Servidor v{$meInfo.version} · {$meInfo.tz}</p>
    {/if}
  </main>

  <nav class="tabs" aria-label="Navegación inferior">
    <ul>
      {#each items as it (it.route)}
        {@const active = $currentRoute === it.route}
        <li>
          <a href={`#/${it.route}`} class="tab" aria-current={active ? 'page' : undefined}>
            {@render icon(it.icon)}
            <span class:mark={active}>{it.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  <a class="fab" href="#/nota-rapida" aria-label="Nota rápida">{@render plus()}</a>
</div>

<style>
  /* Movil y tableta (< 1024px): barra de pestanas inferior + boton flotante */
  .shell {
    --tabs-h: 60px;
    min-height: 100dvh;
  }

  .side {
    display: none;
  }

  .main {
    padding: calc(var(--safe-top) + var(--sp-5)) max(var(--sp-4), var(--safe-right))
      calc(var(--tabs-h) + var(--safe-bottom) + 56px + var(--sp-5)) max(var(--sp-4), var(--safe-left));
  }

  .page {
    max-width: 720px;
    margin: 0 auto;
  }

  .server-info {
    max-width: 720px;
    margin: var(--sp-6) auto 0;
    font-size: var(--fs-xs);
    color: var(--ink-2);
  }

  .tabs {
    position: fixed;
    inset: auto 0 0;
    z-index: 20;
    padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: saturate(1.4) blur(12px);
    -webkit-backdrop-filter: saturate(1.4) blur(12px);
    border-top: 1px solid var(--line);
  }

  .tabs ul {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    max-width: 560px;
    margin: 0 auto;
    padding: 0;
    list-style: none;
  }

  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: var(--tabs-h);
    color: var(--ink-2);
    font-size: var(--fs-xs);
    font-weight: 600;
    text-decoration: none;
  }

  .tab[aria-current='page'] {
    color: var(--ink);
  }

  .tab:focus-visible {
    outline-offset: -4px;
  }

  .fab {
    position: fixed;
    z-index: 21;
    right: calc(var(--sp-4) + var(--safe-right));
    bottom: calc(var(--tabs-h) + var(--safe-bottom) + var(--sp-4));
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: var(--shadow-float);
    transition: transform var(--dur) var(--ease);
  }

  .fab:active {
    transform: scale(0.94);
  }

  .fab:focus-visible {
    border-radius: 50%;
  }

  /* Escritorio (>= 1024px): menu lateral fijo */
  @media (min-width: 1024px) {
    .shell {
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr);
    }

    .tabs,
    .fab {
      display: none;
    }

    .side {
      position: sticky;
      top: 0;
      display: flex;
      flex-direction: column;
      gap: var(--sp-5);
      height: 100dvh;
      overflow-y: auto;
      padding: var(--sp-6) var(--sp-4) var(--sp-5);
      border-right: 1px solid var(--line);
    }

    .brand {
      padding: 0 var(--sp-3);
      font-family: var(--font-display);
      font-size: var(--fs-l);
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .side ul {
      display: grid;
      gap: 2px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .side-link {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
      min-height: var(--tap);
      padding: 0 var(--sp-3);
      border-radius: var(--r-s);
      color: var(--ink-2);
      font-weight: 600;
      text-decoration: none;
    }

    .side-link:hover {
      background: var(--surface-2);
      color: var(--ink);
    }

    .side-link[aria-current='page'] {
      color: var(--ink);
    }

    .side-quick {
      justify-content: flex-start;
      padding-left: var(--sp-3);
    }

    .main {
      padding: var(--sp-7) var(--sp-7) var(--sp-7);
    }

    .page,
    .server-info {
      max-width: 880px;
    }
  }
</style>
