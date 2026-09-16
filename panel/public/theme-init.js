/* theme-init.js — aplica el tema guardado ANTES de pintar la página, para
   evitar el parpadeo de claro→oscuro. Debe cargarse como el primer <script>
   dentro de <head>, antes de styles.css y de cualquier contenido. La vista
   clara sigue siendo la que se usa por defecto — solo se activa oscura si el
   usuario la eligió explícitamente antes (nunca por preferencia del sistema
   operativo). */
(function () {
  try {
    if (localStorage.getItem('karri_theme') === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {}
})();
