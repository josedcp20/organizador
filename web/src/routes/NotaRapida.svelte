<script lang="ts">
  import { navigateTo } from '../router';

  let title = 'Nota Rápida';
  let noteText = $state('');

  function handleSave() {
    // TODO: Save quick note
    navigateTo('notas');
  }

  function handleCancel() {
    navigateTo('hoy');
  }
</script>

<div class="container">
  <h1>{title}</h1>
  <textarea aria-label="Texto de la nota" placeholder="Escribe tu nota..." bind:value={noteText}></textarea>
  <div class="actions">
    <button onclick={handleSave}>Guardar</button>
    <button onclick={handleCancel} class="secondary">Cancelar</button>
  </div>
</div>

<style>
  .container {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h1 {
    margin: 0;
  }

  textarea {
    flex: 1;
    min-height: 200px;
    padding: 0.5rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  button {
    padding: 0.75rem 1.5rem;
    background-color: #4285f4;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
  }

  button:hover {
    background-color: #357ae8;
  }

  button.secondary {
    background-color: #999;
  }

  button.secondary:hover {
    background-color: #666;
  }
</style>
