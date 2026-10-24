<script lang="ts">
  import { currentParams, currentRoute, getQueryParams, navigateTo } from './router';
  import Evento from './routes/Evento.svelte';
  import EventoEditar from './routes/EventoEditar.svelte';
  import { session, setReturnTo, takeReturnTo } from './lib/auth';
  import Layout from './components/Layout.svelte';
  import CalendarFilter from './components/CalendarFilter.svelte';
  import Login from './routes/Login.svelte';
  import Hoy from './routes/Hoy.svelte';
  import Calendario from './routes/Calendario.svelte';
  import Notas from './routes/Notas.svelte';
  import NotaRapida from './routes/NotaRapida.svelte';
  import Ajustes from './routes/Ajustes.svelte';

  // Guard: sin token solo se ve login y no se monta ninguna vista con datos.
  $effect(() => {
    if (!$session) {
      if ($currentRoute !== 'login') {
        // El atajo de nota rapida vuelve a ella tras el login; cualquier otra ruta no deja retorno.
        if ($currentRoute === 'nota-rapida') setReturnTo('nota-rapida');
        else takeReturnTo();
        navigateTo('login');
      }
    } else if ($currentRoute !== 'login') {
      // Autenticado y fuera de login: una ruta de retorno pendiente ya no aplica.
      takeReturnTo();
    }
  });
</script>

{#if !$session || $currentRoute === 'login'}
  <Login />
{:else}
  <Layout>
    {#snippet sidebar()}
      {#if $currentRoute === 'calendario'}<CalendarFilter variant="list" />{/if}
    {/snippet}
    {#if $currentRoute === 'calendario'}
      <Calendario />
    {:else if $currentRoute === 'notas'}
      <Notas />
    {:else if $currentRoute === 'nota-rapida'}
      <NotaRapida />
    {:else if $currentRoute === 'evento'}
      {#key $currentParams.join('/')}
        <Evento calendarId={$currentParams[0] ?? ''} eventId={$currentParams[1] ?? ''} />
      {/key}
    {:else if $currentRoute === 'nuevo-evento'}
      <EventoEditar date={getQueryParams().get('fecha')} />
    {:else if $currentRoute === 'editar-evento'}
      {#key $currentParams.join('/')}
        <EventoEditar calendarId={$currentParams[0] ?? ''} eventId={$currentParams[1] ?? ''} />
      {/key}
    {:else if $currentRoute === 'ajustes'}
      <Ajustes />
    {:else}
      <Hoy />
    {/if}
  </Layout>
{/if}
