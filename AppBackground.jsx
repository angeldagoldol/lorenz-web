import LiquidChrome from './LiquidChrome';

// Render this once near the top of your app root (e.g. in App.jsx, right
// before your routes/screens). It fills the viewport and sits behind
// everything thanks to the .liquid-chrome-bg class (z-index: -1) added
// to style.css / style1.css.
export default function AppBackground() {
  return (
    <div className="liquid-chrome-bg">
      <LiquidChrome
        baseColor={[0.1, 0.1, 0.1]}
        speed={0.97}
        amplitude={0.3}
        interactive
      />
    </div>
  );
}

// Usage in App.jsx:
//
// import AppBackground from './AppBackground';
//
// function App() {
//   return (
//     <>
//       <AppBackground />
//       {/* ...rest of your app... */}
//     </>
//   );
// }
