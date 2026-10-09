# Design: Lume

The operator UI speaks Lume, omadia's own visual language. The idea is that
light is the material: surfaces read as condensed out of light, and the
agent's attention shows up as accent-tinted illumination, not as flat color.
Four recipes carry it. Surfaces are gradient pairs, borders catch the light on
their top edge, one accent slot glows to mark focus and selection, and corners
stay soft.

Three accent palettes ship, Petrol, Atelier, and Lagoon as the default. The
operator picks one and switches between light and dark from the header. The
whole theme lives in a single token file (`web-ui/app/_lib/theme.css`), so
restyling stays a change at the token tier rather than a sweep through
components.

Lume is specified in [byte5ai/omadia-ui](https://github.com/byte5ai/omadia-ui)
under `docs/visual-spec.md`, the same language omadia's canvas app is built on.
The operator UI and the canvas app share one identity.
