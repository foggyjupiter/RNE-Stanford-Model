// plotly.js-dist-min은 plotly.js와 같은 API를 담은 번들이므로 그 타입을 그대로 쓴다.
declare module "plotly.js-dist-min" {
	import * as Plotly from "plotly.js";
	export default Plotly;
}
