<script lang="ts">
  import { session, meInfo } from '../lib/auth';
  import { logout } from '../lib/api';

  let title = 'Ajustes';
</script>

<div class="container">
  <h1>{title}</h1>
  <p>Configuración y preferencias.</p>
  <section aria-label="Sesión">
    <p>
      Sesión: <strong>{$session ? 'conectado' : 'sin sesión'}</strong>
      {#if $meInfo}
        <small>(servidor v{$meInfo.version}, {$meInfo.tz})</small>
      {/if}
    </p>
    <button type="button" onclick={() => logout()}>Cerrar sesión</button>
  </section>
  <ul>
    <li>Conectar Google Calendar</li>
    <li>Notificaciones push</li>
    <li>Preferencias visuales</li>
    <li>Información de la app</li>
  </ul>
</div>

<style>
  .container {
    padding: 1rem;
  }

  h1 {
    margin: 0 0 1rem 0;
  }

  ul {
    list-style: none;
    padding: 0;
  }

  li {
    padding: 0.75rem;
    border-bottom: 1px solid #eee;
  }

  small {
    color: #777;
  }

  button {
    padding: 0.5rem 1rem;
    background-color: #999;
    color: white;
    border: none;
    border-radius: 4px;
  }
</style>
