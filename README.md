Allegro
==========

Command-line tool for generating release notes from git logs. Feed it two IPs running different builds of the same application and it will generate a list of changes that happened between the builds, including a jar-by-jar comparison.

To run, you need to install node: [http://nodejs.org/](http://nodejs.org/) -- it's a simple package-based install on macs.

1. From inside the allegro/ folder, install dependencies:

    `$ npm install`

2. To use this tool: 

    `$ node lib/allegro.js --help`

Requirements
-------------

* The application that you're comparing must be running Karyon (and thus the admin console that exposes archaius properties)

* The application must be exporting build properties to archaius (i.e., using Gradle distro 0.36 or higher)

* To find which hosts to compare, use the fate tool to query asgard

* The tool is tested (so far) on Mac. It ought to work on Linux. It doesn't work on windows.

* You should be using a shell with ssh keys that stash recognizes


Examples
---------

1. HTML formatting to a file (avoids wrapping truncation)

    `$ bin/allegro --html -f $( fate --disabled-ip 0 datacollection-test ) -s $( fate --ip 0 datacollection-test ) > datacollection-1.2-76-1.3-5.html`

2. Wiki-like formatting (table headers need clean-up)

    `$ bin/allegro --wiki -f $( fate --ip 0 sark-prod ) -s $( fate --ip 0 sark-dogfood )`

