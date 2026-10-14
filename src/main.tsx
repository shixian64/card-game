import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './CombatApp';
import Admin from './Admin';
const View=window.location.pathname.startsWith('/admin')?Admin:App;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><View/></React.StrictMode>);
