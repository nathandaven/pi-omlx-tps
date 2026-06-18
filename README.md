# pi-omlx-stats

This extension is basic and adds omlx stat reporting using the built in omlx stats endpoint. The goal was to bring the stats given by the webui to the processing prompt.

![](./screenshots/demo.gif)

**Example**:

```sh
 ⠴ Loading model... (17.0% complete, 31.2s remaining, 3.4gb/25.4gb used)
 ⠏ Preparing... (21.2gb/25.7gb used)
 ⠼ Prefilling... (83.7% complete, 31.6s remaining, 22.7gb/25.1gb used)
 ⠸ Generating... (20.0 tok/s, 2.1s elapsed, 20.1gb/25.3gb used)
```

It is reccomended to use the other omlx extension for the model configuration.

## Install

```sh
# npm
pi install npm:pi-omlx-stats

# git
pi install git:github.com/nathandaven/pi-omlx-tps
```

## Screenshots

![](./screenshots/1-loading.jpg)

![](./screenshots/2-preparing.jpg)

![](./screenshots/3-prefilling.jpg)

![](./screenshots/4-generating.jpg)


## License

MIT
