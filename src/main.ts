import { mount } from 'svelte';
import App from './App.svelte';
import { createController } from './controller';
import './styles.css';

if (!document.getElementById('bilfav-select-root')) {
  const target = document.createElement('div'); target.id = 'bilfav-select-root'; document.body.append(target);
  mount(App, { target, props: { controller: createController() } });
}
