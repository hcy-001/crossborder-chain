import {request} from "node:https";

export function fetchJson(url, onDone) {
  request(url, (response) => {
    let raw = "";
    response.on("data", (chunk) => {
      raw += chunk;
    });
    response.on("end", () => onDone(JSON.parse(raw)));
  }).end();
}
