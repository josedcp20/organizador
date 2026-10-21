<script lang="ts">
  import { currentRoute, navigateTo } from './router';
  import { session } from './lib/auth';
  import Layout from './components/Layout.svelte';
  import Login from './routes/Login.svelte';
  import Hoy from './routes/Hoy.svelte';
  import Calendario from './routes/Calendario.svelte';
  import Notas from './routes/Notas.svelte';
  import NotaRapida from './routes/NotaRapida.svelte';
  import Ajustes from './routes/Ajustes.svelte';

  // Guard: sin token solo se ve login y no se monta ninguna vista con datos.
  $effect(() => {
    if (!$session && $currentRoute !== 'login') navigateTo('login');
  });
</script>

{#if !$session || $currentRoute === 'login'}
  <Login />
{:else}
  <Layout>
    {#if $currentRoute === 'calendario'}
      <Calendario />
    {:else if $currentRoute === 'notas'}
      <Notas />
    {:else if $currentRoute === 'nota-rapida'}
      <NotaRapida />
    {:else if $currentRoute === 'ajustes'}
      <Ajustes />
    {:else}
      <Hoy />
    {/if}
  </Layout>
{/if}

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu',
      'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    background-color: #fff;
    color: #333;
    height: 100%;
  }

  :global(html),
  :global(#app) {
    height: 100%;
  }

  :global(button) {
    cursor: pointer;
    font-family: inherit;
  }
</style>
