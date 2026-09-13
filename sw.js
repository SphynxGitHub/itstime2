self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "It's Time 2 Alert";
  const options = {
    body: data.body || 'You have a new practice update.',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { url: data.url || '/app' }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});
